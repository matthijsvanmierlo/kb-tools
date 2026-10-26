import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { storage } from '../src/core/storage.js';
import { store } from '../src/state/store.js';
import { ClassManager } from '../src/components/class-manager.js';
import { ContextBar } from '../src/components/context-bar.js';
import { Sanitizer } from '../src/core/sanitizer.js';
import { SearchEngine } from '../src/core/search-engine.js';

describe('Phase 1: Universal Class Context Bar & Workspace Breadcrumbs (#3)', () => {
  beforeEach(async () => {
    localStorage.clear();
    store.setActiveClass(null);
  });

  it('synchronizes active class state between store and ClassManager', () => {
    let eventReceived = null;
    const listener = (e) => {
      eventReceived = e.detail;
    };
    window.addEventListener('kb-class-filter-changed', listener, { once: true });

    const sampleCourse = {
      id: 'course-bio-101',
      name: 'Biology Honors',
      section: 'Period 1',
      color: '#2563eb'
    };

    store.setActiveClass(sampleCourse);

    expect(store.getState('activeCourseId')).toBe('course-bio-101');
    expect(store.getState('activeCourse').name).toBe('Biology Honors');
    expect(ClassManager.getActiveFilter()).toBe('course-bio-101');
    expect(localStorage.getItem('kb_active_class_filter')).toBe('course-bio-101');
    expect(eventReceived).not.toBeNull();
    expect(eventReceived.classId).toBe('course-bio-101');

    // Test ClassManager.setActiveFilter delegating back to store
    ClassManager.setActiveFilter('course-chem-202');
    expect(store.getState('activeCourseId')).toBe('course-chem-202');
    expect(localStorage.getItem('kb_active_class_filter')).toBe('course-chem-202');

    // Test clearing filter
    ClassManager.setActiveFilter(null);
    expect(store.getState('activeCourseId')).toBeNull();
    expect(localStorage.getItem('kb_active_class_filter')).toBeNull();
  });

  it('computes breadcrumbs dynamically according to route and active course', () => {
    const course = { id: 'bio-1', name: 'Biology' };

    // Teacher gradebook route
    const crumbsGradebook = ContextBar._computeBreadcrumbs('#/gradebook', '#/gradebook?courseId=bio-1', course, 'teacher');
    expect(crumbsGradebook.map(c => c.label)).toEqual(['Home', 'Biology', 'Gradebook']);

    // Teacher assignment create route
    const crumbsAsg = ContextBar._computeBreadcrumbs('#/assignments/create', '#/assignments/create?id=lab-1', course, 'teacher');
    expect(crumbsAsg.map(c => c.label)).toEqual(['Home', 'Biology', 'Assignments', 'Editor']);

    // Student course route
    const crumbsStudent = ContextBar._computeBreadcrumbs('#/student/courses', '#/student/courses', null, 'student');
    expect(crumbsStudent.map(c => c.label)).toEqual(['Student', 'My Courses']);
  });
});

describe('Phase 1: Full-Text Search Engine & Bi-Directional Wiki (#7)', () => {
  beforeEach(async () => {
    await storage.init();
    await storage.table('flashcards').clear();
    await storage.table('assignments').clear();
    await storage.table('gradebook_courses').clear();
  });

  it('parses [[wikilinks]] into semantic anchors and escapes malicious XSS payloads', () => {
    // 1. Typed wikilink
    const html1 = Sanitizer.renderSTEMMarkdown('Study [[flashcards:Cell Organelles]] before class.');
    expect(html1).toContain('class="kb-wikilink kb-wikilink-flashcards"');
    expect(html1).toContain('href="#/flashcards?search=Cell%20Organelles"');
    expect(html1).toContain('Cell Organelles');

    // 2. Timeline wikilink
    const html2 = Sanitizer.renderSTEMMarkdown('Review [[timeline:The Cold War]] overview.');
    expect(html2).toContain('class="kb-wikilink kb-wikilink-timeline"');
    expect(html2).toContain('href="#/timeline?search=The%20Cold%20War"');

    // 3. General wikilink
    const html3 = Sanitizer.renderSTEMMarkdown('Key concept: [[Photosynthesis]] process.');
    expect(html3).toContain('class="kb-wikilink kb-wikilink-general"');
    expect(html3).toContain('href="#/search?q=Photosynthesis"');

    // 4. Malicious XSS inside wikilink
    const malicious = 'Test [[<script>alert("xss")</script>]] link.';
    const htmlMalicious = Sanitizer.renderSTEMMarkdown(malicious);
    expect(htmlMalicious).not.toContain('<script>');
    expect(htmlMalicious).toContain('&lt;script&gt;');

    // 5. Code blocks protect double brackets from wikilink parsing
    const codeBlock = 'Here is code:\n```js\nconst arr = [[1, 2], [3, 4]];\n```';
    const htmlCode = Sanitizer.renderSTEMMarkdown(codeBlock);
    expect(htmlCode).not.toContain('class="kb-wikilink"');
    expect(htmlCode).toContain('[[1, 2], [3, 4]]');
  });

  it('indexes documents and ranks title matches above body-only matches', async () => {
    await storage.table('flashcards').put({
      id: 'deck-mitosis',
      title: 'Mitosis and Meiosis Stages',
      description: 'Cell division phases',
      cards: [
        { front: 'Prophase', back: 'Chromosomes condense and spindle forms.' },
        { front: 'Metaphase', back: 'Chromosomes align on equatorial plate.' }
      ]
    });

    await storage.table('flashcards').put({
      id: 'deck-genetics',
      title: 'Mendelian Genetics Overview',
      description: 'Punnett squares and alleles',
      cards: [
        { front: 'Independent Assortment', back: 'Occurs during meiosis in cell division.' }
      ]
    });

    await SearchEngine.init();

    // Query for "mitosis": deck-mitosis has it in title, deck-genetics has none
    const resultsMitosis = await SearchEngine.search('mitosis');
    expect(resultsMitosis.length).toBeGreaterThan(0);
    expect(resultsMitosis[0].id).toBe('fc_deck-mitosis');

    // Query for "meiosis": both mention it, but deck-mitosis has it in the title (3.0x weight)
    const resultsMeiosis = await SearchEngine.search('meiosis');
    expect(resultsMeiosis.length).toBe(2);
    expect(resultsMeiosis[0].id).toBe('fc_deck-mitosis');
    expect(resultsMeiosis[0].score).toBeGreaterThan(resultsMeiosis[1].score);

    // Prefix matching for queries >= 3 characters (e.g. "chromo")
    const resultsPrefix = await SearchEngine.search('chromo');
    expect(resultsPrefix.some(r => r.id === 'fc_deck-mitosis')).toBe(true);
  });
});
