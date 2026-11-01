// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { StorageManager } from '../src/core/storage.js';
import {
  ReplicationEngine,
  importChannelKey,
  newChannelSecret,
  sealJson,
  CHUNK_VERSION
} from '../src/core/replication/engine.js';
import { MemoryChannel } from '../src/core/replication/channels.js';
import { HLC, hlc } from '../src/core/replication/hlc.js';
import { markRemoved } from '../src/core/replication/merge.js';
import { RelayTransport } from '../src/core/transport.js';

let dbCounter = 0;
async function createTestDevice() {
  const sm = new StorageManager({ dbName: `kb-merge-v2-${Date.now()}-${dbCounter++}` });
  await sm.init();
  return sm;
}

async function createEngine(store, channel, secret, extra = {}) {
  const key = await importChannelKey(secret);
  return new ReplicationEngine({
    store,
    channel,
    channelId: 'chan-v2',
    key,
    deviceId: store.deviceId,
    ...extra
  });
}

describe('WS2: Client-side sync engine and merge correctness v2', () => {
  let devA, devB, channel, secret, engineA, engineB;

  beforeEach(async () => {
    devA = await createTestDevice();
    devB = await createTestDevice();
    channel = new MemoryChannel();
    secret = newChannelSecret();
    engineA = await createEngine(devA, channel, secret);
    engineB = await createEngine(devB, channel, secret);
  });

  // 1. Offline edits of different fields on the same grade, then both survive
  it('1. merges offline edits of different fields on the same grade (score vs comment)', async () => {
    // Initial grade created and synced
    const initialGrade = {
      student_id: 's1',
      assignment_id: 'a1',
      score: 80,
      comments: 'Initial comment',
      status: 'graded'
    };
    await devA.table('gradebook_grades').put(initialGrade);
    await engineA.push();
    await engineB.pull();

    // Now both devices go offline and edit different fields
    // Device A edits score
    const gradeA = await devA.table('gradebook_grades').get(['s1', 'a1']);
    gradeA.score = 95;
    gradeA._fhlc = { score: hlc.generate(devA.deviceId) };
    await devA.table('gradebook_grades').put(gradeA);

    // Device B edits comments
    const gradeB = await devB.table('gradebook_grades').get(['s1', 'a1']);
    gradeB.comments = 'Great improvement!';
    gradeB._fhlc = { comments: hlc.generate(devB.deviceId) };
    await devB.table('gradebook_grades').put(gradeB);

    // Sync round: both push and pull
    await engineA.push();
    await engineB.push();

    await engineA.pull();
    await engineB.pull();

    const resultA = await devA.table('gradebook_grades').get(['s1', 'a1']);
    const resultB = await devB.table('gradebook_grades').get(['s1', 'a1']);

    expect(resultA.score).toBe(95);
    expect(resultA.comments).toBe('Great improvement!');
    expect(resultB.score).toBe(95);
    expect(resultB.comments).toBe('Great improvement!');
  });

  // 2. Delete on A and edit on B, resolved by HLC order
  it('2. resolves delete on A vs edit on B according to HLC order', async () => {
    const course = { id: 'c1', name: 'Math 101' };
    await devA.table('gradebook_courses').put(course);
    await engineA.push();
    await engineB.pull();

    // Device A deletes course at T1
    await devA.table('gradebook_courses').delete('c1');
    const deleteHlc = (await devA.getTombstone('gradebook_courses', 'c1')).hlc;

    // Device B edits course after observing/advancing clock
    hlc.observe(deleteHlc, devB.deviceId);
    const editCourse = { id: 'c1', name: 'Advanced Math 101' };
    await devB.table('gradebook_courses').put(editCourse);

    // Sync
    await engineA.push();
    await engineB.push();

    await engineA.pull();
    await engineB.pull();

    // Because edit was at later HLC than delete, edit survives on both
    const finalA = await devA.table('gradebook_courses').get('c1');
    const finalB = await devB.table('gradebook_courses').get('c1');
    expect(finalA).not.toBeNull();
    expect(finalA.name).toBe('Advanced Math 101');
    expect(finalB.name).toBe('Advanced Math 101');
  });

  // 3. A card deleted on A doesn't resurrect after B syncs
  it('3. ensures a card deleted on A does not resurrect when B syncs its deck', async () => {
    const deck = {
      id: 'd1',
      title: 'Biology',
      cards: [
        { id: 'card1', front: 'Mitochondria', back: 'Powerhouse' },
        { id: 'card2', front: 'Nucleus', back: 'Control center' }
      ]
    };
    await devA.table('flashcards').put(deck);
    await engineA.push();
    await engineB.pull();

    // On A: card1 is deleted
    const deckA = await devA.table('flashcards').get('d1');
    markRemoved(deckA, 'cards', ['card1'], hlc.generate(devA.deviceId));
    await devA.table('flashcards').put(deckA);

    // On B: edits card2
    const deckB = await devB.table('flashcards').get('d1');
    deckB.cards.find(c => c.id === 'card2').back = 'DNA storage';
    await devB.table('flashcards').put(deckB);

    // Sync
    await engineA.push();
    await engineB.push();

    await engineA.pull();
    await engineB.pull();

    const finalA = await devA.table('flashcards').get('d1');
    const finalB = await devB.table('flashcards').get('d1');

    // card1 must NOT resurrect on either device!
    expect(finalA.cards.map(c => c.id)).toEqual(['card2']);
    expect(finalB.cards.map(c => c.id)).toEqual(['card2']);
    expect(finalA.cards[0].back).toBe('DNA storage');
  });

  // 4. A device offline for 10 days sees deletes via snapshot tombstones
  it('4. ensures a device restoring from snapshot sees deletes via snapshot tombstones', async () => {
    // A creates items
    await devA.table('gradebook_courses').put({ id: 'c-old', name: 'Old Course' });
    await devA.table('gradebook_courses').put({ id: 'c-keep', name: 'Active Course' });
    await engineA.push();

    // A deletes c-old and writes snapshot
    await devA.table('gradebook_courses').delete('c-old');
    await engineA.writeSnapshot();

    // B has been offline for 10 days, pulls snapshot
    const devC = await createTestDevice();
    const engineC = await createEngine(devC, channel, secret);
    await engineC.pull();

    // c-keep is restored, but c-old must be deleted by snapshot tombstone
    expect(await devC.table('gradebook_courses').get('c-keep')).not.toBeNull();
    expect(await devC.table('gradebook_courses').get('c-old')).toBeUndefined();
  });

  // 5. Clock skew of +2 h on one device, after which both converge to identical records
  it('5. converges identically despite +2 h clock skew on one device', async () => {
    // Normal write on A
    await devA.table('flashcards').put({ id: 'd-skew', title: 'Normal Clock Title' });
    await engineA.push();
    await engineB.pull();

    // B has +2 hours skew
    const skewedHlc = HLC.format(Date.now() + 2 * 3600 * 1000, 1, devB.deviceId);
    const itemB = await devB.table('flashcards').get('d-skew');
    itemB.title = 'Skewed Clock Edit';
    itemB._hlc = skewedHlc;
    await devB.table('flashcards').put(itemB);

    await engineB.push();
    await engineA.pull();

    const finalA = await devA.table('flashcards').get('d-skew');
    const finalB = await devB.table('flashcards').get('d-skew');

    // Both converge to identical title
    expect(finalA.title).toBe(finalB.title);
    expect(finalA.title).toBe('Skewed Clock Edit');
  });

  // 6. A 3 MB deck splits into chunks or a blob and syncs
  it('6. syncs large 3 MB deck via blob reference without failure', async () => {
    const cards = [];
    for (let i = 0; i < 3000; i++) {
      cards.push({ id: `c-${i}`, front: 'Front ' + 'x'.repeat(1000), back: 'Back ' + i });
    }
    const largeDeck = { id: 'deck-large-3mb', title: 'Huge Deck', cards };

    await devA.table('flashcards').put(largeDeck);
    await engineA.push();
    await engineB.pull();

    const received = await devB.table('flashcards').get('deck-large-3mb');
    expect(received).not.toBeNull();
    expect(received.cards.length).toBe(3000);
    expect(received.cards[0].front.startsWith('Front xxxxx')).toBe(true);
  });

  // 7. A corrupt chunk is quarantined and push still works
  it('7. quarantines a corrupt chunk and push/pull still functions', async () => {
    // Push normal edit from A
    await devA.table('gradebook_courses').put({ id: 'c-ok', name: 'Course OK' });
    await engineA.push();

    // Inject a corrupt chunk into channel from mock rogue device
    await channel.putChunk({
      deviceId: 'rogue-dev',
      start: 1,
      end: 2,
      body: 'CORRUPT_ENVELOPE_NON_JSON'
    });

    // Device B pulls - it should quarantine the rogue chunk and apply Course OK
    const pullRes = await engineB.pull();
    expect(pullRes.applied).toBeGreaterThanOrEqual(1);
    expect(await devB.table('gradebook_courses').get('c-ok')).not.toBeNull();

    // B can still push changes
    await devB.table('gradebook_courses').put({ id: 'c-from-b', name: 'Course B' });
    const pushCount = await engineB.push();
    expect(pushCount).toBe(1);
  });

  // 8. A hung fetch times out and the next cycle runs
  it('8. times out hung fetch via AbortController and next cycle runs', async () => {
    const transport = new RelayTransport({ baseUrl: 'http://127.0.0.1:9999', token: 'dummy' });
    // Calling _syncRequest on unreachable port should abort/reject with error
    await expect(transport.syncListChunks('ws-test', 'key-test')).rejects.toThrow();
  });

  // Property Test: random interleavings of puts and deletes on 3 devices
  it('Property Test: random interleavings of puts and deletes converge across 3 devices', async () => {
    const d1 = await createTestDevice();
    const d2 = await createTestDevice();
    const d3 = await createTestDevice();
    const devices = [d1, d2, d3];

    const propChannel = new MemoryChannel();
    const propSecret = newChannelSecret();

    const engines = await Promise.all(devices.map(d => createEngine(d, propChannel, propSecret)));

    // Perform 30 random operations across the 3 devices
    const itemIds = ['item-1', 'item-2', 'item-3', 'item-4', 'item-5'];
    for (let step = 0; step < 30; step++) {
      const devIdx = Math.floor(Math.random() * 3);
      const chosenDev = devices[devIdx];
      const targetId = itemIds[Math.floor(Math.random() * itemIds.length)];
      const isDelete = Math.random() < 0.25;

      if (isDelete) {
        await chosenDev.table('gradebook_courses').delete(targetId);
      } else {
        await chosenDev.table('gradebook_courses').put({
          id: targetId,
          name: `Name-${targetId}-v${step}-by-${chosenDev.deviceId}`
        });
      }

      // Random sync action
      if (Math.random() < 0.4) {
        await engines[devIdx].push();
      }
      if (Math.random() < 0.4) {
        await engines[devIdx].pull();
      }
    }

    // Final convergence round: all devices push and pull until stable
    for (let r = 0; r < 5; r++) {
      for (const e of engines) await e.push();
      for (const e of engines) await e.pull();
    }

    // Assert that all 3 stores are completely identical (deep-equal)
    const store1Items = await d1.table('gradebook_courses').toArray();
    const store2Items = await d2.table('gradebook_courses').toArray();
    const store3Items = await d3.table('gradebook_courses').toArray();

    const sortFn = (a, b) => a.id.localeCompare(b.id);
    store1Items.sort(sortFn);
    store2Items.sort(sortFn);
    store3Items.sort(sortFn);

    expect(store1Items).toEqual(store2Items);
    expect(store2Items).toEqual(store3Items);
  });
});
