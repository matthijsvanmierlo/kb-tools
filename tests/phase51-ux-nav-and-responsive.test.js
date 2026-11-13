import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { storage } from '../src/core/storage.js';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('Phase 51: Adaptive Navigation & Responsive LMS Views', () => {
  beforeEach(async () => {
    await storage.init();
    document.body.innerHTML = '<div id="kb-app-nav"></div><div id="kb-context-bar"></div>';
    window.location.hash = '#/';
  });

  it('1. Desktop nav labels use >= 1150px breakpoint, mobile hides duplicate #kb-header-more, and coarse pointers get 36px touch targets', () => {
    const css = fs.readFileSync(path.join(ROOT, 'css/app.css'), 'utf8');
    expect(css).toContain('@media (min-width: 1150px)');
    expect(css).toContain('@media (max-width: 639px)');
    expect(css).toContain('#kb-header-more');
    expect(css).toContain('@media (pointer: coarse)');
    expect(css).toContain('min-width: 36px');
    expect(css).toContain('.btn-copy-student-pass');
  });

  it('2. app-nav.js wraps nav links in <sl-tooltip hoist>, scopes More drawer by role, and highlights More when drawer route is active', async () => {
    const { renderAppNav, ensureMoreDrawer, updateActiveNav } = await import('../src/components/app-nav.js');
    const navEl = document.getElementById('kb-app-nav');
    renderAppNav(navEl, 'teacher');
    expect(navEl.querySelectorAll('sl-tooltip[hoist]').length).toBeGreaterThan(0);

    ensureMoreDrawer('teacher');
    const teacherDrawer = document.getElementById('kb-nav-more-drawer');
    expect(teacherDrawer?.textContent).toContain('Classes & Rosters');
    expect(teacherDrawer?.textContent).toContain('Switch to Student View');
    expect(teacherDrawer?.textContent).toContain('Appearance');

    ensureMoreDrawer('student');
    const studentDrawer = document.getElementById('kb-nav-more-drawer');
    expect(studentDrawer?.textContent).toContain('Switch to Teacher View');
    expect(studentDrawer?.textContent).not.toContain('Classes & Rosters');

    updateActiveNav('#/classes');
    const moreBtn = document.getElementById('btn-kb-nav-more');
    expect(moreBtn?.classList.contains('kb-nav-active')).toBe(true);
  });

  it('3. ContextBar renders compact mobile breadcrumb and Back pill', async () => {
    const { ContextBar } = await import('../src/components/context-bar.js');
    const barEl = document.getElementById('kb-context-bar');
    window.location.hash = '#/gradebook';
    ContextBar.init('kb-context-bar');
    await ContextBar.render();
    expect(barEl.innerHTML).toContain('sm:hidden');
    expect(barEl.innerHTML).toContain('Gradebook');
  });

  it('4. Classes master-detail, Task Review split-pane, and Roster view include mobile-first responsive controls', () => {
    const classesSrc = fs.readFileSync(path.join(ROOT, 'src/modules/classes/index.js'), 'utf8');
    expect(classesSrc).toContain('id="mobile-classes-drawer"');
    expect(classesSrc).toContain('id="btn-open-mobile-classes"');

    const reviewSrc = fs.readFileSync(path.join(ROOT, 'src/modules/tasks/review.js'), 'utf8');
    expect(reviewSrc).toContain('id="review-mobile-pane-bar"');
    expect(reviewSrc).toContain('id="btn-mob-pane-work"');
    expect(reviewSrc).toContain('id="btn-mob-pane-grade"');
    expect(reviewSrc).toContain('setMobilePane');

    const rosterSrc = fs.readFileSync(path.join(ROOT, 'src/modules/gradebook/roster-view.js'), 'utf8');
    expect(rosterSrc).toContain('Mobile Card View');
    expect(rosterSrc).toContain('sticky left-0 z-10');
    expect(rosterSrc).toContain("params.set('relay', relayUrl)");
  });
});
