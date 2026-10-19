import { describe, it, expect } from 'vitest';
import { buildClickableHtmlFile, extractEnvelopeFromHtml } from '../src/core/html-launcher.js';
import { classifyText } from '../src/core/envelope-router.js';
import { canInstallPwa, classifyIncomingFile } from '../src/core/pwa.js';

describe('Phase 34: Clickable HTML Launcher & PWA Handlers', () => {
  it('builds a standalone offline-capable HTML file with embedded payload', () => {
    const payload = {
      kind: 'kb-assignment',
      assignment_id: 'asg-math-101',
      title: 'Calculus Quiz 1',
      questions: [{ id: 'q1', prompt: 'Solve 2x + 4 = 10' }]
    };

    const html = buildClickableHtmlFile({
      title: 'Calculus Quiz 1',
      payloadType: 'assignment',
      payload,
      studentName: 'Alex Mercer',
      studentId: 'ST-901'
    });

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Calculus Quiz 1');
    expect(html).toContain('Alex Mercer');
    expect(html).toContain('id="kb-payload"');
    expect(html).toContain('asg-math-101');
  });

  it('extracts embedded envelope from HTML launcher', () => {
    const payload = {
      kind: 'assignment_feedback',
      assignment: { title: 'Midterm Exam' },
      score: { earned: 45, possible: 50 }
    };

    const html = buildClickableHtmlFile({
      title: 'Midterm Feedback',
      payloadType: 'feedback',
      payload
    });

    const extracted = extractEnvelopeFromHtml(html);
    expect(extracted).toBeTruthy();
    expect(extracted.kind).toBe('assignment_feedback');
    expect(extracted.score.earned).toBe(45);
  });

  it('extracts raw string KBSUB codes from HTML launcher', () => {
    const html = `
      <html>
        <body>
          <script id="kb-payload" type="application/json">
            KBSUB1.eyJrYnN1YiI6MSwidGVzdCI6dHJ1ZX0=
          </script>
        </body>
      </html>
    `;
    const extracted = extractEnvelopeFromHtml(html);
    expect(extracted).toBe('KBSUB1.eyJrYnN1YiI6MSwidGVzdCI6dHJ1ZX0=');
  });

  it('classifyText transparently unwraps HTML launchers and identifies content kinds', () => {
    const asgPayload = {
      kind: 'kb-assignment',
      assignment_id: 'asg-physics',
      publish_version: 2
    };
    const htmlAsg = buildClickableHtmlFile({
      title: 'Physics Lab',
      payloadType: 'assignment',
      payload: asgPayload
    });

    const classifiedAsg = classifyText(htmlAsg);
    expect(classifiedAsg.kind).toBe('assignment');
    expect(classifiedAsg.assignment_id).toBe('asg-physics');

    const fbPayload = {
      kind: 'assignment_feedback',
      assignment: { id: 'asg-physics', title: 'Physics Lab' },
      course: { id: 'phy101', name: 'Physics' }
    };
    const htmlFb = buildClickableHtmlFile({
      title: 'Physics Feedback',
      payloadType: 'feedback',
      payload: fbPayload
    });

    const classifiedFb = classifyText(htmlFb);
    expect(classifiedFb.kind).toBe('assignment_feedback');
    expect(classifiedFb.assignment_id).toBe('asg-physics');
  });

  it('classifies incoming file extensions for PWA routing', () => {
    expect(classifyIncomingFile('quiz.kbsub')).toBe('inbox');
    expect(classifyIncomingFile('video.kbr')).toBe('inbox');
    expect(classifyIncomingFile('handin.zip')).toBe('inbox');
    expect(classifyIncomingFile('myfeedback.kbfeedback')).toBe('feedback');
    expect(classifyIncomingFile('lesson.kbshare')).toBe('share');
  });

  it('checks PWA installation capability hook', () => {
    expect(typeof canInstallPwa).toBe('function');
    expect(canInstallPwa()).toBe(false);
  });
});
