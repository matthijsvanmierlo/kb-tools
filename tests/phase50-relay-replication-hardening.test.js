import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { StorageManager } from '../src/core/storage.js';
import { ReplicationEngine, importChannelKey, newChannelSecret } from '../src/core/replication/engine.js';
import { ReplicationManager } from '../src/core/replication/manager.js';
import { MemoryChannel } from '../src/core/replication/channels.js';
import { RelayTransport } from '../src/core/transport.js';

let dbCounter = 0;
async function makeStore() {
  const sm = new StorageManager({ dbName: `kb-p50-${Date.now()}-${dbCounter++}` });
  await sm.init();
  return sm;
}

describe('Phase 50: Relay Sync & Replication Hardening', () => {
  it('1. Co-teacher snapshot includes assignment_submissions, task_submissions, and referenced shared rubrics', async () => {
    const teacherA = await makeStore();
    const teacherB = await makeStore();
    const channel = new MemoryChannel();
    const key = await importChannelKey(newChannelSecret());

    // Course A + shared rubric + assignment + task + submissions (without course_id on submissions)
    await teacherA.table('gradebook_courses').put({ id: 'course-1', name: 'Biology' });
    await teacherA.table('gradebook_rubrics').put({ id: 'rub-shared', course_id: null, title: 'Shared Lab Rubric', tiers: [], criteria: [] });
    await teacherA.table('gradebook_rubrics').put({ id: 'rub-other', course_id: 'course-2', title: 'Other Class Rubric', tiers: [], criteria: [] });
    await teacherA.table('assignments').put({ id: 'asg-1', class_id: 'course-1', title: 'Quiz 1', questions: [] });
    await teacherA.table('tasks').put({ id: 'task-1', class_id: 'course-1', title: 'Lab 1', grading: { rubric_id: 'rub-shared' } });
    await teacherA.table('assignment_submissions').put({ id: 'asub-1', assignment_id: 'asg-1', student_id: 'S1' });
    await teacherA.table('task_submissions').put({ id: 'tsub-1', task_id: 'task-1', student_id: 'S1' });
    await teacherA.table('task_submissions').put({ id: 'tsub-other', task_id: 'task-other', student_id: 'S2' });

    const engA = new ReplicationEngine({ store: teacherA, channel, channelId: 'share-c1', key, deviceId: teacherA.deviceId, courseId: 'course-1' });
    await engA.writeSnapshot();

    const engB = new ReplicationEngine({ store: teacherB, channel, channelId: 'share-c1', key, deviceId: teacherB.deviceId, courseId: 'course-1' });
    await engB.pull();

    expect(await teacherB.table('assignment_submissions').get('asub-1')).toBeTruthy();
    expect(await teacherB.table('task_submissions').get('tsub-1')).toBeTruthy();
    expect(await teacherB.table('task_submissions').get('tsub-other')).toBeUndefined();
    expect(await teacherB.table('gradebook_rubrics').get('rub-shared')).toBeTruthy();
    expect(await teacherB.table('gradebook_rubrics').get('rub-other')).toBeUndefined();
  });

  it('2. Co-teacher live op _inScope resolves task_submissions via task_id even when course_id is null', async () => {
    const teacherA = await makeStore();
    const channel = new MemoryChannel();
    const key = await importChannelKey(newChannelSecret());

    await teacherA.table('tasks').put({ id: 'task-9', class_id: 'course-9', title: 'Essay' });
    const eng = new ReplicationEngine({ store: teacherA, channel, channelId: 'share-c9', key, deviceId: teacherA.deviceId, courseId: 'course-9' });

    const inScope = await eng._inScope({
      table: 'task_submissions',
      op: 'put',
      key: 'ts-9',
      record: { id: 'ts-9', task_id: 'task-9', student_id: 'S1' }
    });
    expect(inScope).toBe(true);
  });

  it('3. stopSharing deletes relay workspace when local teacher is the owner', async () => {
    const store = await makeStore();
    const mgr = new ReplicationManager({ store });

    const syncDeleteWorkspace = vi.fn().mockResolvedValue(true);
    mgr._relayFor = vi.fn().mockResolvedValue({ syncDeleteWorkspace });
    mgr._shareSecret = vi.fn().mockResolvedValue(undefined);
    mgr.classShare = vi.fn().mockResolvedValue({
      owner: true,
      relay: { base_url: 'https://relay.test', workspace_id: 'ws-123', workspace_key: 'wk-abc' }
    });

    await mgr.stopSharing('course-1');
    expect(syncDeleteWorkspace).toHaveBeenCalledWith('ws-123', 'wk-abc');
  });

  it('4. RelayTransport.init populates deviceId and generates/persists deviceToken', async () => {
    const t = new RelayTransport();
    await t.init({ baseUrl: 'https://relay.test', token: 'tok' });
    expect(t.deviceId).toBeTruthy();
    expect(t.deviceToken).toMatch(/^[a-f0-9]{64}$/);
  });
});
