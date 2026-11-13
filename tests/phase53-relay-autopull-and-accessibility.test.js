import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { storage } from '../src/core/storage.js';
import { Router } from '../src/router.js';
import { pollAllActiveDrops } from '../src/core/drop-pull.js';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('Phase 53: Relay Auto-Pull & Accessibility Announcements', () => {
  beforeEach(async () => {
    await storage.init();
    await storage.table('assignments').clear();
    await storage.table('tasks').clear();
    await storage.table('video_assessments').clear();
    await storage.setMetadata('relay_staged_submissions', []);

    document.body.innerHTML = '<div id="kb-aria-announcer" aria-live="polite"></div><span id="sync-status-indicator"></span>';
  });

  it('1. Router._announceRouteChange announces friendly route names including student and settings routes', () => {
    const router = new Router({});
    router._announceRouteChange('#/student/gradebook');
    expect(document.getElementById('kb-aria-announcer').textContent).toBe('Navigated to My Grades');

    router._announceRouteChange('#/settings');
    expect(document.getElementById('kb-aria-announcer').textContent).toBe('Navigated to Settings');

    router._announceRouteChange('#/classes');
    expect(document.getElementById('kb-aria-announcer').textContent).toBe('Navigated to Classes & Rosters');
  });

  it('2. pollAllActiveDrops returns empty gracefully when no relay transport is configured', async () => {
    const res = await pollAllActiveDrops({ autoStage: true });
    expect(res).toEqual({ count: 0, staged: 0, failures: [], items: [] });
  });

  it('3. Inbox & main.js wire Pull & Auto-Import, staged relay badge count, and live replication status', () => {
    const inboxSrc = fs.readFileSync(path.join(ROOT, 'src/modules/inbox/index.js'), 'utf8');
    expect(inboxSrc).toContain('id="btn-pull-auto-import"');
    expect(inboxSrc).toContain('relay_staged_submissions');

    const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
    expect(mainSrc).toContain('relay_staged_submissions');
    expect(mainSrc).toContain('kb-relay-submissions-staged');
    expect(mainSrc).toContain('kb-replication-status');
    expect(mainSrc).toContain('runTeacherDropPoll');
  });
});
