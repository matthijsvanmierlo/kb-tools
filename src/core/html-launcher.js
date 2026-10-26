/**
 * HTML Launcher (KB-CORE-LAUNCHER)
 *
 * Generates and unwraps self-launching HTML files (*.kbshare.html, *.kbsub.html, *.kbfeedback.html)
 * so that students and teachers can double-click them in any web browser (Safari, Firefox, Chrome, Edge)
 * without needing prior app installation or command-line tools.
 * Also parses and unwraps HTML launchers when dropped onto the app or opened via file picker.
 */

import { Sanitizer } from './sanitizer.js';

const esc = (s) => Sanitizer.escapeHTML(String(s ?? ''));

/**
 * Extract embedded KennisBoost payload or envelope from an HTML launcher file string.
 * @param {string} htmlText
 * @returns {object|string|null} parsed payload object, raw KBSUB string, or null
 */
export function extractEnvelopeFromHtml(htmlText) {
  if (typeof htmlText !== 'string' || !htmlText.includes('kb-payload')) return null;

  // 1. Script tag with id="kb-payload"
  const scriptMatch = htmlText.match(/<script[^>]+id=["']kb-payload["'][^>]*>([\s\S]*?)<\/script>/i);
  if (scriptMatch && scriptMatch[1]) {
    const raw = scriptMatch[1].trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      if (raw.startsWith('KBSUB1.')) return raw;
      return null;
    }
  }

  // 2. Data attribute fallback: data-kb-payload="..."
  const attrMatch = htmlText.match(/data-kb-payload=["']([^"']+)["']/i);
  if (attrMatch && attrMatch[1]) {
    try {
      const decoded = decodeURIComponent(attrMatch[1]);
      return JSON.parse(decoded);
    } catch (_) {
      try {
        return JSON.parse(attrMatch[1]);
      } catch (_) {}
    }
  }

  return null;
}

/**
 * Resolve the default web app URL for launchers based on current browser location or configuration.
 * @returns {string}
 */
export function resolveDefaultAppUrl() {
  if (typeof window !== 'undefined' && window.location && (window.location.protocol === 'http:' || window.location.protocol === 'https:')) {
    return `${window.location.origin}${window.location.pathname}`;
  }
  if (typeof window !== 'undefined' && window.KB_CONFIG?.appUrl) {
    return window.KB_CONFIG.appUrl;
  }
  return 'https://mvanmierlo.github.io/kb-tools/';
}

/**
 * Build a self-contained, offline-capable HTML file that opens in any browser on double click.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {'assignment'|'submission'|'feedback'|'report'|'lesson'} opts.payloadType
 * @param {object|string} opts.payload - object or KBSUB string
 * @param {string} [opts.studentName]
 * @param {string} [opts.studentId]
 * @param {string} [opts.instructions]
 * @param {string} [opts.appUrl] - fallback web app URL
 * @param {string} [opts.shareUrl] - direct share link with #/share hash if available
 * @param {boolean} [opts.autoLaunch=true] - automatically redirect to app after brief display
 * @returns {string} full HTML document
 */
export function buildClickableHtmlFile({
  title = 'KennisBoost File',
  payloadType = 'lesson',
  payload,
  studentName = '',
  studentId = '',
  instructions = '',
  appUrl = resolveDefaultAppUrl(),
  shareUrl = '',
  autoLaunch = true
}) {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const now = new Date().toLocaleString();

  const typeLabels = {
    assignment: 'Assessment Package',
    submission: 'Student Submission',
    feedback: 'Assessment Feedback',
    report: 'Grade Report',
    lesson: 'KennisBoost Lesson'
  };

  const typeLabel = typeLabels[payloadType] || 'KennisBoost File';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="kennisboost-type" content="${esc(payloadType)}">
  <title>${esc(title)} · KennisBoost</title>
  <style>
    :root {
      --primary: #2563eb;
      --primary-hover: #1d4ed8;
      --bg: #f8fafc;
      --card-bg: #ffffff;
      --text-main: #0f172a;
      --text-muted: #64748b;
      --border: #e2e8f0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text-main);
      display: flex;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 20px;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.01);
      width: 100%;
      max-width: 520px;
      padding: 32px;
      text-align: center;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 9999px;
      background: #eff6ff;
      color: var(--primary);
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 16px;
      border: 1px solid #bfdbfe;
    }
    h1 {
      font-size: 22px;
      font-weight: 700;
      line-height: 1.3;
      margin-bottom: 10px;
      color: var(--text-main);
    }
    .meta {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 24px;
      line-height: 1.5;
    }
    .status-msg {
      font-size: 13px;
      font-weight: 600;
      color: var(--primary);
      margin-bottom: 16px;
      min-height: 20px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      padding: 13px 20px;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.15s ease;
      text-decoration: none;
    }
    .btn-primary {
      background: var(--primary);
      color: #ffffff;
      margin-bottom: 12px;
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.25);
    }
    .btn-primary:hover {
      background: var(--primary-hover);
    }
    .btn-secondary {
      background: #f1f5f9;
      color: #334155;
      border: 1px solid var(--border);
    }
    .btn-secondary:hover {
      background: #e2e8f0;
    }
    .instructions {
      margin-top: 24px;
      padding: 14px;
      border-radius: 12px;
      background: #f8fafc;
      border: 1px dashed var(--border);
      font-size: 12px;
      color: var(--text-muted);
      text-align: left;
      line-height: 1.5;
    }
    .brand-footer {
      margin-top: 20px;
      font-size: 11px;
      color: #94a3b8;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">${esc(typeLabel)}</div>
    <h1>${esc(title)}</h1>
    <div class="meta">
      ${studentName ? `<div><strong>Student:</strong> ${esc(studentName)}${studentId ? ` (${esc(studentId)})` : ''}</div>` : ''}
      <div><strong>Created:</strong> ${esc(now)}</div>
    </div>

    <div id="launch-status" class="status-msg">${autoLaunch ? 'Opening in KennisBoost Tools…' : ''}</div>

    <button id="btn-open-app" class="btn btn-primary">Open in KennisBoost Tools</button>
    <button id="btn-copy-code" class="btn btn-secondary">Copy Data Code</button>

    <div class="instructions">
      <strong>Zero-Trust Client-Side LMS:</strong> This file contains offline encrypted educational data. Double-clicking opens this launcher in your browser. Clicking "Open in KennisBoost Tools" activates the file locally without sending any data over the internet.
    </div>

    <div class="brand-footer">
      KennisBoost Tools · 100% Client-Side Local-First Platform
    </div>
  </div>

  <script id="kb-payload" type="application/json">
${serialized}
  </script>

  <script>
    (function() {
      const payloadEl = document.getElementById('kb-payload');
      const payloadText = payloadEl ? payloadEl.textContent.trim() : '';
      const appBaseUrl = ${JSON.stringify(appUrl)};
      const shareUrl = ${JSON.stringify(shareUrl || '')};
      const payloadType = ${JSON.stringify(payloadType)};
      const title = ${JSON.stringify(title)};
      const autoLaunch = ${JSON.stringify(Boolean(autoLaunch))};

      function openInApp() {
        const statusEl = document.getElementById('launch-status');
        if (statusEl) statusEl.textContent = 'Launching…';

        // 1. Cross-Origin Envelope via window.name (persists across file:// -> https:// navigation in the same tab)
        try {
          window.name = 'KB_LAUNCH_V1:' + JSON.stringify({
            payloadType: payloadType,
            title: title,
            payload: payloadText
          });
        } catch (_) {}

        // 2. Fallback to sessionStorage if on same origin
        try {
          sessionStorage.setItem('kb_incoming_payload', payloadText);
        } catch (_) {}

        // 3. Determine navigation target
        let targetUrl = '';
        if (shareUrl && shareUrl.length <= 32768) {
          targetUrl = shareUrl;
        } else {
          const isFileProtocol = window.location.protocol === 'file:';
          targetUrl = isFileProtocol ? appBaseUrl : './index.html';

          if (!targetUrl.endsWith('/') && !targetUrl.includes('.html')) {
            targetUrl += '/';
          }

          if (payloadType === 'assignment') {
            targetUrl = targetUrl.replace(/#.*$/, '') + '#/assessments/take';
          } else if (payloadType === 'feedback') {
            targetUrl = targetUrl.replace(/#.*$/, '') + '#/student/gradebook';
          } else if (payloadType === 'submission') {
            targetUrl = targetUrl.replace(/#.*$/, '') + '#/inbox?import=1';
          } else if (payloadType === 'report') {
            targetUrl = targetUrl.replace(/#.*$/, '') + '#/report';
          } else if (payloadType === 'lesson') {
            targetUrl = targetUrl.replace(/#.*$/, '') + '#/';
          }
        }

        try {
          window.location.href = targetUrl;
        } catch (_) {
          window.open(targetUrl, '_self');
        }
      }

      document.getElementById('btn-open-app').addEventListener('click', openInApp);

      const copyBtn = document.getElementById('btn-copy-code');
      copyBtn.addEventListener('click', async function() {
        try {
          await navigator.clipboard.writeText(payloadText);
          const orig = copyBtn.textContent;
          copyBtn.textContent = 'Copied to Clipboard!';
          setTimeout(() => { copyBtn.textContent = orig; }, 2000);
        } catch (_) {
          alert('Could not copy automatically. Select and copy from the page source.');
        }
      });

      if (autoLaunch) {
        setTimeout(openInApp, 150);
      }
    })();
  </script>
</body>
</html>`;
}

/**
 * Trigger download of a clickable .html launcher file in the browser.
 * @param {object} opts - parameters for buildClickableHtmlFile
 * @param {string} [filename] - download filename (e.g. 'lesson.kbshare.html')
 */
export function downloadClickableHtmlFile(opts, filename) {
  const html = buildClickableHtmlFile(opts);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const defaultBase = (opts.title || 'kennisboost-file').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  a.download = filename || `${defaultBase}.html`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (a.parentNode) a.parentNode.removeChild(a);
    URL.revokeObjectURL(url);
  }, 400);
}
