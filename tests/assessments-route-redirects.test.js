import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Router, LEGACY_REDIRECTS } from '../src/router.js';
import { storage } from '../src/core/storage.js';

describe('Assessments & Assignments Routing & Shared Payload Activation', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await storage.init();
    window.location.hash = '#/';
  });

  it('keeps assignments routes within the assignments module without redirecting to assessments', async () => {
    const router = new Router();
    const navSpy = vi.spyOn(router, 'navigate');

    window.location.hash = '#/assignments/create?id=task-123';
    await router.handleRoute();
    expect(navSpy).not.toHaveBeenCalledWith(expect.stringContaining('#/assessments'));

    navSpy.mockClear();
    window.location.hash = '#/assignments/edit?id=task-123';
    await router.handleRoute();
    expect(navSpy).not.toHaveBeenCalledWith(expect.stringContaining('#/assessments'));
  });

  it('preserves legacy gradebook roster view redirect', async () => {
    const router = new Router();
    const navSpy = vi.spyOn(router, 'navigate');

    window.location.hash = '#/gradebook?view=roster&courseId=course-42';
    await router.handleRoute();
    expect(navSpy).toHaveBeenCalledWith('#/classes?tab=roster&courseId=course-42');
  });

  it('lands on #/assessments/take when activating a shared assignment envelope', async () => {
    const router = new Router();
    const navSpy = vi.spyOn(router, 'navigate');

    await router._activateSharedPayload({
      type: 'assignment',
      payload: {
        assignment_id: 'asg-test-456',
        title: 'Midterm Assessment'
      }
    });

    expect(navSpy).toHaveBeenCalledWith('#/assessments/take');
  });

  it('lands on #/assignments/work when activating a shared task envelope', async () => {
    const router = new Router();
    const navSpy = vi.spyOn(router, 'navigate');

    await router._activateSharedPayload({
      type: 'task',
      payload: {
        task_id: 'task-test-789',
        title: 'Project Assignment'
      }
    });

    expect(navSpy).toHaveBeenCalledWith('#/assignments/work');
  });
});
