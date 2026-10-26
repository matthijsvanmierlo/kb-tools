import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Router, LEGACY_REDIRECTS } from '../src/router.js';
import { storage } from '../src/core/storage.js';

describe('Assessments Route Redirects & Shared Payload Activation', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await storage.init();
    window.location.hash = '#/';
  });

  it('defines the expected legacy redirects for assignments paths', () => {
    expect(LEGACY_REDIRECTS['#/assignments/take']).toBe('#/assessments/take');
    expect(LEGACY_REDIRECTS['#/assignments/submissions']).toBe('#/assessments/submissions');
    expect(LEGACY_REDIRECTS['#/assignments/edit']).toBe('#/assessments/edit');
  });

  it('redirects legacy assignments routes preserving query parameters', async () => {
    const router = new Router();
    const navSpy = vi.spyOn(router, 'navigate');

    window.location.hash = '#/assignments/take?preview=1&sid=123';
    await router.handleRoute();
    expect(navSpy).toHaveBeenCalledWith('#/assessments/take?preview=1&sid=123');

    navSpy.mockClear();
    window.location.hash = '#/assignments/submissions?id=asg-abc';
    await router.handleRoute();
    expect(navSpy).toHaveBeenCalledWith('#/assessments/submissions?id=asg-abc');

    navSpy.mockClear();
    window.location.hash = '#/assignments/edit?id=asg-xyz';
    await router.handleRoute();
    expect(navSpy).toHaveBeenCalledWith('#/assessments/edit?id=asg-xyz');
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
