/**
 * CartridgeBridge - KB-CARTRIDGE-001
 *
 * Proposal #8: Universal LMS Cartridge Bridge (IMS Common Cartridge & Standalone HTML Packs)
 *
 * 1. IMS Common Cartridge (.imscc / .zip):
 *    Pure client-side import from Canvas, Moodle, Blackboard, and Schoology.
 *    Extracts imsmanifest.xml, units, QTI assessment items, and web content.
 *
 * 2. Standalone Zero-Server HTML Pack:
 *    Generates self-contained single-file HTML runnable offline from USB thumb drives.
 */

import jszipLib from 'jszip';
import { Sanitizer } from './sanitizer.js';

const JSZip = jszipLib.default || jszipLib;

export class CartridgeBridge {
  /**
   * Import an IMS Common Cartridge (.imscc or .zip).
   *
   * @param {File|Blob|ArrayBuffer} zipFileOrBlob
   * @returns {Promise<{ course: object, units: Array<object>, items: Array<object> }>}
   */
  static async importCommonCartridge(zipFileOrBlob) {
    const zip = await JSZip.loadAsync(zipFileOrBlob);

    // 1. Locate and parse imsmanifest.xml
    const manifestFile = zip.file('imsmanifest.xml') || zip.file(/^.*imsmanifest\.xml$/i)[0];
    if (!manifestFile) {
      throw new Error('Not a valid Common Cartridge: imsmanifest.xml not found.');
    }

    const manifestText = await manifestFile.async('text');
    const parser = typeof DOMParser !== 'undefined' ? new DOMParser() : null;
    if (!parser) {
      throw new Error('DOMParser is not available.');
    }

    const doc = parser.parseFromString(manifestText, 'application/xml');
    if (doc.querySelector('parsererror')) {
      throw new Error('Malformed imsmanifest.xml file.');
    }

    // 2. Extract Course Title & Metadata
    const courseId = `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let courseTitle = doc.querySelector('metadata lom\\:general lom\\:title lom\\:string, metadata title string, metadata title')?.textContent?.trim()
      || doc.querySelector('manifest > metadata')?.textContent?.trim()
      || 'Imported Common Cartridge Course';

    let courseDesc = doc.querySelector('metadata lom\\:general lom\\:description lom\\:string, metadata description string')?.textContent?.trim() || '';

    const course = {
      id: courseId,
      name: courseTitle,
      description: courseDesc,
      section: 'Imported Cartridge',
      color: '#4f46e5',
      created_at: new Date().toISOString()
    };

    // 3. Map Resources by identifier
    const resourceMap = new Map();
    const resourceNodes = doc.querySelectorAll('resources > resource');
    resourceNodes.forEach(res => {
      const identifier = res.getAttribute('identifier');
      const type = res.getAttribute('type') || '';
      const href = res.getAttribute('href') || '';
      resourceMap.set(identifier, { identifier, type, href });
    });

    // 4. Parse Organization Items into Units and Lessons
    const units = [];
    const items = [];
    const orgItems = doc.querySelectorAll('organizations > organization > item');

    let unitOrder = 0;
    for (const orgItem of orgItems) {
      const unitTitle = orgItem.querySelector(':scope > title')?.textContent?.trim() || `Unit ${unitOrder + 1}`;
      const unitId = `unit-${courseId}-${unitOrder + 1}`;

      units.push({
        id: unitId,
        course_id: courseId,
        title: unitTitle,
        order: unitOrder++
      });

      // Child items inside this unit
      const childItems = orgItem.querySelectorAll(':scope > item');
      let itemOrder = 0;
      for (const child of childItems) {
        const itemTitle = child.querySelector(':scope > title')?.textContent?.trim() || `Lesson ${itemOrder + 1}`;
        const identifierRef = child.getAttribute('identifierref');
        const res = resourceMap.get(identifierRef);

        let kind = 'task';
        let content = '';

        if (res && res.href) {
          const contentFile = zip.file(res.href) || zip.file(new RegExp(res.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'))[0];
          if (contentFile) {
            content = await contentFile.async('text');
            if (res.href.endsWith('.html') || res.href.endsWith('.htm')) {
              kind = 'task';
            } else if (res.type.includes('assessment') || res.href.endsWith('.xml') || res.href.endsWith('.qti')) {
              kind = 'assignment';
            }
          }
        }

        items.push({
          id: `item-${courseId}-${units.length}-${itemOrder + 1}`,
          course_id: courseId,
          unit_id: unitId,
          title: itemTitle,
          kind,
          content: {
            text_md: content,
            raw_href: res?.href || ''
          },
          points: 100,
          created_at: new Date().toISOString()
        });

        itemOrder++;
      }
    }

    return { course, units, items };
  }

  /**
   * Export a course as a standalone, zero-server runnable HTML package.
   *
   * @param {object} params
   * @param {object} params.course
   * @param {Array<object>} params.units
   * @param {Array<object>} params.items
   * @returns {string} Complete HTML string
   */
  static exportStandaloneHtmlCourse({ course, units = [], items = [] }) {
    const coursePayload = JSON.stringify({
      course,
      units,
      items,
      exported_at: new Date().toISOString()
    }).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${Sanitizer.escapeHTML(course.name || 'Course Pack')} - KennisBoost Offline</title>
  <style>
    :root { --primary: ${Sanitizer.safeColor(course.color, '#2563eb')}; --bg: #f8fafc; --text: #0f172a; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; padding: 1.5rem; }
    .container { max-width: 900px; margin: 0 auto; }
    header { background: #fff; border: 1px solid #e2e8f0; border-radius: 1rem; padding: 1.5rem; margin-bottom: 1.5rem; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    h1 { font-size: 1.5rem; font-weight: 700; color: #1e293b; margin-bottom: 0.25rem; }
    .badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; background: #e0e7ff; color: #3730a3; }
    .unit-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 1rem; margin-bottom: 1.5rem; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    .unit-header { background: #f1f5f9; padding: 1rem 1.25rem; font-weight: 700; font-size: 1rem; border-bottom: 1px solid #e2e8f0; }
    .item-row { padding: 1rem 1.25rem; border-bottom: 1px solid #f1f5f9; display: flex; align-items: center; justify-between: space-between; }
    .item-row:last-child { border-bottom: none; }
    .btn { background: var(--primary); color: #fff; border: none; padding: 0.5rem 1rem; border-radius: 0.5rem; font-size: 0.875rem; font-weight: 600; cursor: pointer; text-decoration: none; display: inline-block; }
    .btn:hover { opacity: 0.9; }
    .prose { padding: 1.5rem; font-size: 0.95rem; line-height: 1.6; }
    .footer-note { text-align: center; font-size: 0.75rem; color: #94a3b8; margin-top: 2rem; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <span class="badge">Offline Zero-Server Pack</span>
      <h1 class="mt-2">${Sanitizer.escapeHTML(course.name)}</h1>
      <p style="color: #64748b; font-size: 0.875rem;">${Sanitizer.escapeHTML(course.description || 'Self-contained offline course.')}</p>
    </header>

    <div id="course-mount">
      ${units.map((u, idx) => {
        const uItems = items.filter(it => it.unit_id === u.id);
        return `
          <div class="unit-card">
            <div class="unit-header">Unit ${idx + 1}: ${Sanitizer.escapeHTML(u.title)}</div>
            <div>
              ${uItems.map(it => `
                <div class="item-row" style="display: flex; justify-content: space-between; align-items: center;">
                  <div>
                    <strong style="font-size: 0.95rem;">${Sanitizer.escapeHTML(it.title)}</strong>
                    <div style="font-size: 0.8rem; color: #64748b; text-transform: capitalize;">${Sanitizer.escapeHTML(it.kind || 'Lesson')} · ${it.points || 100} pts</div>
                  </div>
                  <button class="btn btn-view-lesson" data-item-id="${Sanitizer.escapeHTML(it.id)}">Read Lesson</button>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }).join('')}
    </div>

    <div id="lesson-modal" style="display:none; position: fixed; inset: 0; background: rgba(0,0,0,0.5); padding: 1.5rem; align-items: center; justify-content: center;">
      <div style="background:#fff; border-radius: 1rem; max-width: 700px; width: 100%; max-height: 85vh; display: flex; flex-direction: column; overflow: hidden;">
        <div style="padding: 1rem 1.25rem; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center;">
          <h2 id="modal-title" style="font-size: 1.1rem; font-weight: 700;"></h2>
          <button id="modal-close" class="btn" style="background:#e2e8f0; color:#334155; padding: 0.3rem 0.6rem;">✕</button>
        </div>
        <div id="modal-body" class="prose" style="overflow-y: auto; flex: 1;"></div>
      </div>
    </div>

    <div class="footer-note">
      KennisBoost Offline Cartridge Pack · 100% Client-Side · Zero Cloud Dependency
    </div>
  </div>

  <script id="kb-course-data" type="application/json">${coursePayload}</script>
  <script>
    (function() {
      const data = JSON.parse(document.getElementById('kb-course-data').textContent);
      const modal = document.getElementById('lesson-modal');
      const mTitle = document.getElementById('modal-title');
      const mBody = document.getElementById('modal-body');
      const mClose = document.getElementById('modal-close');

      document.querySelectorAll('.btn-view-lesson').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-item-id');
          const item = data.items.find(it => it.id === id);
          if (item) {
            mTitle.textContent = item.title;
            const text = item.content?.text_md || item.content?.text || 'No content available for this lesson.';
            mBody.innerHTML = text;
            modal.style.display = 'flex';
          }
        });
      });

      mClose.addEventListener('click', () => { modal.style.display = 'none'; });
      modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
    })();
  </script>
</body>
</html>`;
  }
}

export default CartridgeBridge;
