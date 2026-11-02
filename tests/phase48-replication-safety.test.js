import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import crypto from 'node:crypto';
import { StorageManager } from '../src/core/storage.js';
import { ReplicationEngine, importChannelKey, newChannelSecret } from '../src/core/replication/engine.js';
import { ReplicationManager } from '../src/core/replication/manager.js';
import { MemoryChannel } from '../src/core/replication/channels.js';
import { HLC, compareStamp } from '../src/core/replication/hlc.js';

let dbCounter = 0;
async function device() {
  const sm = new StorageManager({ dbName: `kb-r4-test-${Date.now()}-${dbCounter++}` });
  await sm.init();
  return sm;
}

describe('Phase 48: Replication Data Safety', () => {
  it('1. Two channels, one failing: outbox is preserved until slowest channel catches up', async () => {
    const store = await device();
    const chan1 = new MemoryChannel();
    const chan2 = new MemoryChannel();
    const secret = newChannelSecret();
    const key = await importChannelKey(secret);

    const eng1 = new ReplicationEngine({ store, channel: chan1, channelId: 'c1', key, deviceId: store.deviceId });
    const eng2 = new ReplicationEngine({ store, channel: chan2, channelId: 'c2', key, deviceId: store.deviceId });

    // Store has an item put in outbox
    await store.table('gradebook_students').put({ id: 's1', course_id: 'c1', student_id: 'S1', full_name: 'Student 1' });
    const latestSeq = await store.outbox.latestSeq();
    expect(latestSeq).toBeGreaterThan(0);

    // Chan 1 pushes successfully
    await eng1.push();
    const p1 = await eng1.pushedThrough();
    expect(p1).toBe(latestSeq);

    // Chan 2 fails to push (e.g. throws error)
    vi.spyOn(chan2, 'putChunk').mockRejectedValueOnce(new Error('Network offline'));
    await expect(eng2.push()).rejects.toThrow('Network offline');
    const p2 = await eng2.pushedThrough();
    expect(p2).toBe(0);

    // Prune evaluation based on slowest channel: min(p1, p2) = 0, so outbox must NOT be pruned
    const cursors = [p1, p2];
    const minCursor = Math.min(...cursors);
    if (minCursor > 0 && !cursors.some(c => !c || c <= 0)) {
      await store.outbox.pruneThrough(minCursor);
    }
    const remaining = await store.outbox.since(0);
    expect(remaining.length).toBeGreaterThan(0);

    // Now Chan 2 recovers and pushes
    vi.restoreAllMocks();
    await eng2.push();
    const p2Recovered = await eng2.pushedThrough();
    expect(p2Recovered).toBe(latestSeq);

    // Now min is latestSeq, outbox can be safely pruned
    const cursorsAfter = [await eng1.pushedThrough(), await eng2.pushedThrough()];
    const minAfter = Math.min(...cursorsAfter);
    if (minAfter > 0 && !cursorsAfter.some(c => !c || c <= 0)) {
      await store.outbox.pruneThrough(minAfter);
    }
    expect(await store.outbox.since(0)).toEqual([]);
  });

  it('2. Missing chunk with no snapshot: vector does not advance and status shows gap', async () => {
    const devA = await device();
    const devB = await device();
    const channel = new MemoryChannel();
    const secret = newChannelSecret();
    const key = await importChannelKey(secret);

    const engA = new ReplicationEngine({ store: devA, channel, channelId: 'c1', key, deviceId: devA.deviceId });
    const engB = new ReplicationEngine({ store: devB, channel, channelId: 'c1', key, deviceId: devB.deviceId });

    // Device A creates op 1
    await devA.table('gradebook_students').put({ id: 's1', course_id: 'c1', student_id: 'S1', full_name: 'A' });
    await engA.push();

    // Device A creates op 2
    await devA.table('gradebook_students').put({ id: 's2', course_id: 'c1', student_id: 'S2', full_name: 'B' });
    await engA.push();

    // Now channel has 2 chunks for devA (seq 1..1 and 2..2).
    // Simulate drop/loss of chunk 1:
    for (const [k, c] of channel.chunks.entries()) {
      if (c.start === 1) channel.chunks.delete(k);
    }

    // Device B pulls - it sees chunk start: 2 while vector is 0 (missing 1)
    await engB.pull();

    // Vector for devA should not advance past 0 because seq 1 was missing!
    const vector = await engB.vector();
    expect(vector[devA.deviceId] || 0).toBe(0);

    // Status should have recorded 'gap' problem
    expect(engB.problems.some(p => p.kind === 'gap')).toBe(true);

    // Quarantined row should be stored
    const quarantined = await devB.table('repl_quarantine').toArray();
    expect(quarantined.length).toBe(1);
    expect(quarantined[0].start_seq).toBe(2);
  });

  it('3. Pull cursor advances across polls, and a second poll downloads 0 bodies', async () => {
    const devA = await device();
    const devB = await device();
    const channel = new MemoryChannel();
    const secret = newChannelSecret();
    const key = await importChannelKey(secret);

    const engA = new ReplicationEngine({ store: devA, channel, channelId: 'c1', key, deviceId: devA.deviceId });
    const engB = new ReplicationEngine({ store: devB, channel, channelId: 'c1', key, deviceId: devB.deviceId });

    await devA.table('gradebook_students').put({ id: 's1', course_id: 'c1', student_id: 'S1', full_name: 'A' });
    await engA.push();

    let fetchedBodies = 0;
    const origGetChunk = channel.getChunk.bind(channel);
    channel.getChunk = async (item) => {
      fetchedBodies++;
      return origGetChunk(item);
    };

    // First pull downloads chunk body
    await engB.pull();
    expect(fetchedBodies).toBe(1);

    // Second pull uses updated cursor: channel.listChunks returns [] or no new chunks
    fetchedBodies = 0;
    await engB.pull();
    expect(fetchedBodies).toBe(0);
  });

  it('4. 2 MB record: channel skips it, outbox continues to sync other records, status shows oversize', async () => {
    const store = await device();
    const channel = new MemoryChannel();
    const secret = newChannelSecret();
    const key = await importChannelKey(secret);

    const eng = new ReplicationEngine({ store, channel, channelId: 'c1', key, deviceId: store.deviceId });

    // Put a normal record
    await store.table('gradebook_students').put({ id: 's1', course_id: 'c1', student_id: 'S1', full_name: 'Normal' });

    // Put an uncompressible huge record (> 1MB sealed)
    const hugePayload = crypto.randomBytes(750000).toString('base64');
    await store.table('gradebook_students').put({ id: 's2', course_id: 'c1', student_id: 'S2', full_name: hugePayload });

    // Put another normal record
    await store.table('gradebook_students').put({ id: 's3', course_id: 'c1', student_id: 'S3', full_name: 'Normal 2' });

    // Push should not fail completely; it records oversize problem and syncs the normal records
    await eng.push();

    expect(eng.problems.some(p => p.kind === 'oversize')).toBe(true);

    // Channel should contain chunks for the normal records
    expect(channel.chunks.size).toBeGreaterThan(0);
  });

  it('5. Record with legacy ISO updated_at loses to a newer HLC edit', () => {
    const legacyIso = '2026-05-01T10:00:00.000Z';
    // HLC with timestamp 2026-05-01T11:00:00.000Z (newer wall time)
    const newerHlc = `${Date.parse('2026-05-01T11:00:00.000Z')}-0001-devA`;

    // compareStamp(a, b) returns > 0 if a > b
    expect(compareStamp(newerHlc, legacyIso)).toBeGreaterThan(0);
    expect(compareStamp(legacyIso, newerHlc)).toBeLessThan(0);

    // If wall times are identical, HLC is preferred / higher than legacy ISO
    const sameIso = '2026-05-01T10:00:00.000Z';
    const sameHlc = `${Date.parse('2026-05-01T10:00:00.000Z')}-0001-devA`;
    expect(compareStamp(sameHlc, sameIso)).toBeGreaterThan(0);
  });

  it('6. HLC survives a simulated reload (metadata restore)', async () => {
    const store = await device();
    const hlc1 = new HLC();

    const stamp1 = hlc1.generate(store.deviceId, store);
    expect(stamp1).toContain(store.deviceId);

    // Wait for the throttled persist or force persist
    await store.setMetadata('hlc_last_stamp', stamp1);

    // Create a new HLC instance on the same store (simulating browser reload)
    const hlc2 = new HLC();
    await hlc2.restore(store);

    // The restored last stamp should have advanced past or equal to stamp1
    const stamp2 = hlc2.generate(store.deviceId, store);
    expect(compareStamp(stamp2, stamp1)).toBeGreaterThan(0);
  });

  it('7. pagehide triggers a push sync', async () => {
    const store = await device();
    const manager = new ReplicationManager(store);

    let syncCalledWith = null;
    vi.spyOn(manager, 'syncNow').mockImplementation(async (opts) => {
      syncCalledWith = opts;
      return manager.status;
    });

    manager.start();

    // Dispatch pagehide event on window
    window.dispatchEvent(new Event('pagehide'));

    expect(syncCalledWith).toEqual({ pushOnly: true });

    manager.stop();
  });
});
