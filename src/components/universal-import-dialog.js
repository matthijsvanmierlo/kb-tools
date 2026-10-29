/**
 * UniversalImportDialog - Universal Content Import Dialog (KB-COMP-IMPORT)
 * Ingests .kbshare files, assignments, flashcard decks, timelines, video assessments,
 * student hand-ins (.kbsub), and spreadsheet data into the user's local database.
 */

import { ContentImporter, ContentImportError } from '../core/content-importer.js';
import { Sanitizer } from '../core/sanitizer.js';
import { ClassManager } from './class-manager.js';
import { toast } from '../utils/toast.js';
import {
  parseCSVWithValidation,
  FlashcardItemSchema,
  TimelineEventSchema,
  AssignmentQuestionRowSchema
} from '../core/validator.js';
import {
  downloadCSVTemplate,
  ASSIGNMENT_CSV_TEMPLATE,
  FLASHCARDS_CSV_TEMPLATE,
  TIMELINE_CSV_TEMPLATE,
  ROSTER_CSV_TEMPLATE
} from '../core/csv-templates.js';
import { router } from '../router.js';

export class UniversalImportDialog {
  /**
   * Open the universal content import dialog
   * @param {object} [options]
   * @param {string|null} [options.defaultClassId=null]
   * @param {(result: object) => void} [options.onComplete]
   * @param {'file'|'paste'|'qr'} [options.initialTab='file']
   * @returns {Promise<HTMLElement>}
   */
  static async open({ defaultClassId = null, onComplete = null, initialTab = 'file' } = {}) {
    const dialog = document.createElement('sl-dialog');
    dialog.setAttribute('label', 'Import Educational Content');
    dialog.className = 'kb-universal-import-dialog';
    dialog.style.setProperty('--width', '680px');

    const classes = await ClassManager.getClasses().catch(() => []);
    const initialClassId = defaultClassId || ClassManager.getActiveFilter() || null;

    let activeTab = initialTab || 'file';
    let currentFile = null;
    let isProcessing = false;
    let inspectionResult = null;
    let unpackedData = null; // { type, payload }

    dialog.innerHTML = `
      <div class="space-y-4 py-1 text-sm">
        <div class="text-xs text-slate-500">
          Upload or scan any <strong>.kbshare</strong> lesson package, assignment, flashcard deck, or spreadsheet file. Content is saved directly to your local library with zero server uploads.
        </div>

        <sl-tab-group id="univ-import-tabs">
          <sl-tab slot="nav" panel="tab-file" ${activeTab === 'file' ? 'active' : ''}>
            <sl-icon slot="prefix" name="file-earmark-arrow-up"></sl-icon> Upload File
          </sl-tab>
          <sl-tab slot="nav" panel="tab-paste" ${activeTab === 'paste' ? 'active' : ''}>
            <sl-icon slot="prefix" name="clipboard"></sl-icon> Paste Content
          </sl-tab>
          <sl-tab slot="nav" panel="tab-qr" ${activeTab === 'qr' ? 'active' : ''}>
            <sl-icon slot="prefix" name="qr-code-scan"></sl-icon> Scan QR
          </sl-tab>

          <!-- Tab 1: File Upload -->
          <sl-tab-panel name="tab-file">
            <div class="mt-3 p-6 border-2 border-dashed border-slate-300 hover:border-blue-500 rounded-xl text-center bg-slate-50 transition-colors cursor-pointer" id="univ-drop-zone">
              <sl-icon name="cloud-arrow-up" class="text-3xl text-blue-500 mb-2"></sl-icon>
              <p class="font-medium text-slate-800 text-sm" id="univ-drop-title">Drop a .kbshare, .kbsub, CSV, or JSON file here</p>
              <p class="text-xs text-slate-500 mt-1">Supports .kbshare (lessons/decks), .kbsub (student work), .csv, .tsv, and .json</p>
              <input type="file" id="univ-file-input" accept=".kbshare,.kbsub,.kbr,.csv,.tsv,.json,.txt,.html,.htm,.kbfeedback,.kbsession" class="hidden" />
            </div>

            <div id="univ-file-info" class="hidden mt-2 p-2.5 bg-blue-50 border border-blue-200 rounded-lg flex items-center justify-between text-xs text-blue-900">
              <div class="flex items-center gap-2 truncate">
                <sl-icon name="file-earmark-text" class="text-blue-600 shrink-0"></sl-icon>
                <span id="univ-file-name" class="font-semibold truncate"></span>
                <span id="univ-file-size" class="text-blue-500 font-mono"></span>
              </div>
              <button type="button" id="btn-univ-clear-file" class="text-blue-600 hover:text-blue-900 font-medium ml-2">Change</button>
            </div>
          </sl-tab-panel>

          <!-- Tab 2: Paste Content -->
          <sl-tab-panel name="tab-paste">
            <div class="mt-3 space-y-2">
              <p class="text-xs text-slate-500">
                Paste spreadsheet rows (from Excel or Google Sheets), raw .kbshare contents, or student submission codes:
              </p>
              <sl-textarea id="univ-paste-textarea" rows="6" placeholder="Paste .kbshare data, spreadsheet cells, or KBSUB1. submission code here..."></sl-textarea>
            </div>
          </sl-tab-panel>

          <!-- Tab 3: Scan QR Code -->
          <sl-tab-panel name="tab-qr">
            <div class="mt-3 p-6 border-2 border-dashed border-blue-200 hover:border-blue-500 rounded-xl text-center bg-blue-50/40 transition-colors">
              <sl-icon name="qr-code-scan" class="text-4xl text-blue-600 mb-2"></sl-icon>
              <p class="font-medium text-slate-800 text-sm">Scan Projected or Printed QR Code</p>
              <p class="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                Point your camera at an animated QR stream (.kbshare package) or single QR code (course/assignment link).
              </p>
              <div class="flex items-center justify-center gap-2 mt-4 flex-wrap">
                <sl-button variant="primary" id="btn-univ-open-camera" size="small">
                  <sl-icon slot="prefix" name="camera"></sl-icon> Open Camera Scanner
                </sl-button>
                <sl-button variant="default" id="btn-univ-scan-image" size="small">
                  <sl-icon slot="prefix" name="image"></sl-icon> Scan Image / Screenshot
                </sl-button>
                <input type="file" id="input-univ-qr-file" accept="image/*" class="hidden" />
              </div>
            </div>
          </sl-tab-panel>
        </sl-tab-group>

        <!-- Optional Class Assignment -->
        <div class="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-t border-slate-100">
          <label for="select-univ-class" class="text-xs font-medium text-slate-600">Assign to Class (optional):</label>
          <sl-select id="select-univ-class" size="small" class="w-full sm:w-56" value="${initialClassId || 'none'}">
            <sl-option value="none">None / Unassigned</sl-option>
            ${classes.map(c => `<sl-option value="${Sanitizer.escapeHTML(c.id)}">${Sanitizer.escapeHTML(c.name)}</sl-option>`).join('')}
          </sl-select>
        </div>

        <!-- Live Preview / Status Container -->
        <div id="univ-preview-container" class="hidden border border-slate-200 rounded-xl bg-slate-50/60 p-3.5 space-y-2.5">
          <div class="flex items-center justify-between text-xs">
            <div id="univ-preview-status" class="flex items-center gap-1.5 font-medium text-slate-700"></div>
            <span id="univ-preview-badge" class="text-[11px] text-slate-400"></span>
          </div>

          <!-- Dynamic Decrypt Prompt (if encrypted) -->
          <div id="univ-decrypt-box" class="hidden p-3 bg-amber-50 border border-amber-200 rounded-lg space-y-2">
            <div class="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
              <sl-icon name="lock"></sl-icon> Protected .kbshare Lesson (AES-256)
            </div>
            <p class="text-xs text-amber-700">This content is password-protected. Enter the passphrase or access code to unlock it:</p>
            <div class="flex gap-2">
              <sl-input id="input-univ-passphrase" type="password" password-toggle placeholder="Passphrase or code" size="small" class="flex-1"></sl-input>
              <sl-button size="small" variant="primary" id="btn-univ-unlock">Unlock</sl-button>
            </div>
            <div id="univ-decrypt-error" class="text-xs text-red-600 hidden font-medium"></div>
          </div>

          <!-- Preview Items List -->
          <div id="univ-preview-content" class="overflow-x-auto max-h-40 text-xs bg-white rounded-lg border border-slate-200 divide-y divide-slate-100"></div>
          <div id="univ-preview-error" class="hidden text-xs text-red-600 bg-red-50 p-2.5 rounded-lg border border-red-200"></div>
        </div>
      </div>

      <div slot="footer" class="flex items-center justify-between w-full">
        <div class="flex items-center gap-2">
          <sl-dropdown id="univ-template-dropdown">
            <sl-button slot="trigger" size="small" caret variant="default">
              <sl-icon slot="prefix" name="download"></sl-icon> Templates
            </sl-button>
            <sl-menu id="univ-template-menu">
              <sl-menu-item value="assignment">Assessment CSV Template</sl-menu-item>
              <sl-menu-item value="flashcards">Flashcards CSV Template</sl-menu-item>
              <sl-menu-item value="timeline">Timeline CSV Template</sl-menu-item>
              <sl-menu-item value="roster">Class Roster CSV Template</sl-menu-item>
            </sl-menu>
          </sl-dropdown>
          <sl-button variant="default" id="btn-univ-cancel" size="small">Cancel</sl-button>
        </div>
        <sl-button variant="primary" id="btn-univ-submit" disabled>
          <sl-icon slot="prefix" name="cloud-download"></sl-icon>
          <span id="btn-univ-submit-text">Import to Library</span>
        </sl-button>
      </div>
    `;

    document.body.appendChild(dialog);

    const tabs = dialog.querySelector('#univ-import-tabs');
    const dropZone = dialog.querySelector('#univ-drop-zone');
    const fileInput = dialog.querySelector('#univ-file-input');
    const fileInfo = dialog.querySelector('#univ-file-info');
    const fileNameEl = dialog.querySelector('#univ-file-name');
    const fileSizeEl = dialog.querySelector('#univ-file-size');
    const clearFileBtn = dialog.querySelector('#btn-univ-clear-file');
    const pasteTextarea = dialog.querySelector('#univ-paste-textarea');
    const classSelect = dialog.querySelector('#select-univ-class');
    const previewContainer = dialog.querySelector('#univ-preview-container');
    const previewStatus = dialog.querySelector('#univ-preview-status');
    const previewBadge = dialog.querySelector('#univ-preview-badge');
    const previewContent = dialog.querySelector('#univ-preview-content');
    const previewError = dialog.querySelector('#univ-preview-error');
    const decryptBox = dialog.querySelector('#univ-decrypt-box');
    const passInput = dialog.querySelector('#input-univ-passphrase');
    const unlockBtn = dialog.querySelector('#btn-univ-unlock');
    const decryptError = dialog.querySelector('#univ-decrypt-error');
    const submitBtn = dialog.querySelector('#btn-univ-submit');
    const submitBtnText = dialog.querySelector('#btn-univ-submit-text');
    const cancelBtn = dialog.querySelector('#btn-univ-cancel');

    // UI State updater
    const renderPreviewForUnpacked = (type, payload, filename) => {
      unpackedData = { type, payload };
      decryptBox.classList.add('hidden');
      previewError.classList.add('hidden');
      previewContent.classList.remove('hidden');

      const title = payload.title || payload.name || filename.replace(/\.[^/.]+$/, '') || 'Untitled Content';
      const safeTitle = Sanitizer.escapeHTML(title);

      let items = [];
      let typeLabel = 'Content';
      let badgeColor = 'bg-blue-100 text-blue-800';
      let icon = 'collection';

      if (type === 'flashcards') {
        items = Array.isArray(payload.cards) ? payload.cards : [];
        typeLabel = `Flashcard Deck (${items.length} cards)`;
        badgeColor = 'bg-blue-100 text-blue-800';
        icon = 'stack';
      } else if (type === 'assignment') {
        items = Array.isArray(payload.questions) ? payload.questions : [];
        typeLabel = `Assessment (${items.length} questions)`;
        badgeColor = 'bg-amber-100 text-amber-800';
        icon = 'ui-checks';
      } else if (type === 'timeline') {
        items = Array.isArray(payload.events) ? payload.events : [];
        typeLabel = `Timeline (${items.length} events)`;
        badgeColor = 'bg-purple-100 text-purple-800';
        icon = 'bar-chart-steps';
      } else if (type === 'video') {
        items = Array.isArray(payload.checkpoints) ? payload.checkpoints : [];
        typeLabel = `Video Assessment (${items.length} checkpoints)`;
        badgeColor = 'bg-rose-100 text-rose-800';
        icon = 'play-circle';
      }

      previewStatus.innerHTML = `
        <span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${badgeColor}">
          <sl-icon name="${icon}"></sl-icon> ${Sanitizer.escapeHTML(typeLabel)}
        </span>
        <span class="font-bold text-slate-800 ml-1.5 truncate max-w-xs">${safeTitle}</span>
      `;

      previewBadge.textContent = 'Preview';

      if (items.length === 0) {
        previewContent.innerHTML = '<div class="p-3 text-slate-400 italic text-center">No items found in payload.</div>';
      } else {
        previewContent.innerHTML = items.slice(0, 4).map((it, idx) => {
          const f = it.title || it.prompt || it.front?.text || it.front || `Item #${idx + 1}`;
          const b = it.description || it.back?.text || it.back || (it.start_date ? `Date: ${it.start_date}` : (it.points ? `${it.points} pts` : ''));
          return `
            <div class="p-2 flex items-center justify-between text-xs gap-3">
              <span class="font-medium text-slate-800 truncate">${Sanitizer.escapeHTML(String(f))}</span>
              <span class="text-slate-500 truncate max-w-xs text-[11px]">${Sanitizer.escapeHTML(String(b))}</span>
            </div>
          `;
        }).join('');
      }

      submitBtn.disabled = false;
      submitBtnText.textContent = `Save ${safeTitle} to Library`;
    };

    const inspectAndPreview = async (text, filename = '') => {
      unpackedData = null;
      submitBtn.disabled = true;
      submitBtnText.textContent = 'Import to Library';
      decryptBox.classList.add('hidden');
      decryptError.classList.add('hidden');
      previewError.classList.add('hidden');
      previewContent.innerHTML = '';

      const trimmed = (text || '').trim();
      if (!trimmed) {
        previewContainer.classList.add('hidden');
        return;
      }

      previewContainer.classList.remove('hidden');
      inspectionResult = ContentImporter.inspect(trimmed, filename);

      // Case A: Student Submission (.kbsub or KBSUB1.)
      if (inspectionResult.kind === 'kbsub') {
        previewStatus.innerHTML = `
          <span class="inline-flex items-center gap-1 text-emerald-800 bg-emerald-100 font-semibold px-2.5 py-0.5 rounded-full text-xs">
            <sl-icon name="inbox"></sl-icon> Student Submission Work
          </span>
        `;
        previewBadge.textContent = 'Inbox';
        previewContent.innerHTML = `
          <div class="p-3 text-slate-600 text-xs">
            This file contains student assignment hand-in data. Click below to route directly to your Inbox for grading.
          </div>
        `;
        submitBtn.disabled = false;
        submitBtnText.textContent = 'Route to Inbox';
        return;
      }

      // Case A.2: Student Class Join
      if (inspectionResult.kind === 'student_join') {
        const code = inspectionResult.code;
        previewStatus.innerHTML = `
          <span class="inline-flex items-center gap-1 text-blue-800 bg-blue-100 font-semibold px-2.5 py-0.5 rounded-full text-xs">
            <sl-icon name="mortarboard"></sl-icon> Class Join Code (${Sanitizer.escapeHTML(code)})
          </span>
        `;
        previewBadge.textContent = 'Class';
        previewContent.innerHTML = `
          <div class="p-3 text-slate-600 text-xs">
            Class access code: <strong>${Sanitizer.escapeHTML(code)}</strong>. Click below to join the class and load its lessons and assignments.
          </div>
        `;
        submitBtn.disabled = false;
        submitBtnText.textContent = 'Join Class';
        return;
      }

      // Case B: .kbshare File
      if (inspectionResult.kind === 'kbshare') {
        if (inspectionResult.isEncrypted) {
          previewStatus.innerHTML = `
            <span class="inline-flex items-center gap-1 text-amber-800 bg-amber-100 font-semibold px-2.5 py-0.5 rounded-full text-xs">
              <sl-icon name="lock"></sl-icon> Encrypted .kbshare Lesson
            </span>
          `;
          previewBadge.textContent = 'Protected';
          decryptBox.classList.remove('hidden');
          previewContent.classList.add('hidden');
          submitBtn.disabled = true;
          submitBtnText.textContent = 'Unlock Required';
          return;
        }

        try {
          const unpacked = await ContentImporter.unpackKbShare(trimmed);
          renderPreviewForUnpacked(unpacked.type, unpacked.payload, filename);
          return;
        } catch (err) {
          previewStatus.innerHTML = `
            <span class="inline-flex items-center gap-1 text-rose-800 bg-rose-100 font-semibold px-2 py-0.5 rounded-full text-xs">
              <sl-icon name="exclamation-triangle"></sl-icon> Corrupted .kbshare
            </span>
          `;
          previewError.classList.remove('hidden');
          previewError.textContent = err.message || 'Could not parse .kbshare payload.';
          return;
        }
      }

      // Case C: Raw JSON
      if (inspectionResult.kind === 'json') {
        const p = inspectionResult.parsed;
        let detectedType = 'flashcards';
        let payload = p;

        if (inspectionResult.isSharedEnvelope) {
          detectedType = inspectionResult.shareType;
          payload = p.payload;
        } else if (p.questions) {
          detectedType = 'assignment';
        } else if (p.events) {
          detectedType = 'timeline';
        } else if (p.checkpoints) {
          detectedType = 'video';
        }

        renderPreviewForUnpacked(detectedType, payload, filename);
        return;
      }

      // Case D: CSV / TSV spreadsheet
      if (inspectionResult.kind === 'csv') {
        // 1. Try AssignmentQuestionRowSchema first
        const asgValidated = parseCSVWithValidation(trimmed, AssignmentQuestionRowSchema);
        if (asgValidated.success && asgValidated.data?.length > 0) {
          const asgPayload = {
            title: filename.replace(/\.[^/.]+$/, '').replace(/[_\-]+/g, ' ') || 'Imported Assessment',
            questions: asgValidated.data
          };
          renderPreviewForUnpacked('assignment', asgPayload, filename);
          return;
        }

        // 2. Try TimelineEventSchema next
        const timelineValidated = parseCSVWithValidation(trimmed, TimelineEventSchema);
        if (timelineValidated.success && timelineValidated.data?.length > 0) {
          const timelinePayload = {
            title: filename.replace(/\.[^/.]+$/, '').replace(/[_\-]+/g, ' ') || 'Imported Timeline',
            events: timelineValidated.data
          };
          renderPreviewForUnpacked('timeline', timelinePayload, filename);
          return;
        }

        // 3. Try FlashcardItemSchema
        const flashcardValidated = parseCSVWithValidation(trimmed, FlashcardItemSchema);
        if (flashcardValidated.success && flashcardValidated.data?.length > 0) {
          const deckPayload = {
            title: filename.replace(/\.[^/.]+$/, '').replace(/[_\-]+/g, ' ') || 'Imported Flashcards',
            cards: flashcardValidated.data
          };
          renderPreviewForUnpacked('flashcards', deckPayload, filename);
          return;
        }

        previewStatus.innerHTML = `
          <span class="inline-flex items-center gap-1 text-slate-800 bg-slate-100 font-semibold px-2 py-0.5 rounded-full text-xs">
            <sl-icon name="file-earmark-spreadsheet"></sl-icon> Spreadsheet Data
          </span>
        `;
        previewError.classList.remove('hidden');
        previewError.textContent = asgValidated.errors?.[0]?.message || timelineValidated.errors?.[0]?.message || flashcardValidated.errors?.[0]?.message || 'CSV format not recognized.';
        return;
      }

      // Fallback
      previewStatus.innerHTML = '<span class="text-slate-500">Unrecognized file content</span>';
      previewError.classList.remove('hidden');
      previewError.textContent = 'Please choose a valid .kbshare, .kbsub, CSV, or JSON file.';
    };

    // Unlock button handler
    unlockBtn?.addEventListener('click', async () => {
      const pass = passInput?.value || '';
      if (!pass) return;

      unlockBtn.loading = true;
      decryptError.classList.add('hidden');

      try {
        const text = inspectionResult?.rawText || '';
        const unpacked = await ContentImporter.unpackKbShare(text, pass);
        renderPreviewForUnpacked(unpacked.type, unpacked.payload, inspectionResult?.filename || '');
      } catch (err) {
        decryptError.textContent = err.message || 'Incorrect passphrase.';
        decryptError.classList.remove('hidden');
      } finally {
        unlockBtn.loading = false;
      }
    });

    passInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') unlockBtn?.click();
    });

    // File handlers
    const handleFile = async (file) => {
      if (!file) return;
      currentFile = file;
      fileNameEl.textContent = file.name;
      fileSizeEl.textContent = `(${Math.round(file.size / 1024)} KB)`;
      fileInfo.classList.remove('hidden');
      dropZone.classList.add('hidden');

      try {
        const text = await file.text();
        await inspectAndPreview(text, file.name);
      } catch (err) {
        console.error('Error reading file:', err);
      }
    };

    dropZone?.addEventListener('click', () => fileInput?.click());
    dropZone?.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('border-blue-500', 'bg-blue-50');
    });
    dropZone?.addEventListener('dragleave', () => {
      dropZone.classList.remove('border-blue-500', 'bg-blue-50');
    });
    dropZone?.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('border-blue-500', 'bg-blue-50');
      const file = e.dataTransfer?.files?.[0];
      if (file) handleFile(file);
    });

    fileInput?.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) handleFile(file);
    });

    clearFileBtn?.addEventListener('click', () => {
      currentFile = null;
      fileInput.value = '';
      fileInfo.classList.add('hidden');
      dropZone.classList.remove('hidden');
      inspectAndPreview('', '');
    });

    // Tab change
    tabs?.addEventListener('sl-tab-show', (e) => {
      const tabName = e.detail.name;
      activeTab = tabName === 'tab-paste' ? 'paste' : (tabName === 'tab-qr' ? 'qr' : 'file');
      if (activeTab === 'paste') {
        inspectAndPreview(pasteTextarea?.value || '', 'pasted_data.txt');
      } else if (activeTab === 'file' && currentFile) {
        currentFile.text().then(t => inspectAndPreview(t, currentFile.name));
      } else if (activeTab === 'file') {
        inspectAndPreview('', '');
      }
    });

    // QR Tab button bindings
    const qrCameraBtn = dialog.querySelector('#btn-univ-open-camera');
    const qrScanImgBtn = dialog.querySelector('#btn-univ-scan-image');
    const qrFileInput = dialog.querySelector('#input-univ-qr-file');

    qrCameraBtn?.addEventListener('click', async () => {
      const { openQrScanner } = await import('./qr-handoff.js');
      openQrScanner({
        label: 'Scan Content QR Stream or Code',
        once: true,
        onResult: async (decodedText) => {
          await UniversalImportDialog.handleScannedPayload(decodedText, {
            dialog,
            onScannedContent: (text) => {
              tabs.show('tab-paste');
              if (pasteTextarea) {
                pasteTextarea.value = text;
                inspectAndPreview(text, 'scanned_qr_payload.txt');
              }
            }
          });
        }
      });
    });

    qrScanImgBtn?.addEventListener('click', () => qrFileInput?.click());
    qrFileInput?.addEventListener('change', async () => {
      const file = qrFileInput.files?.[0];
      if (!file) return;
      qrFileInput.value = '';
      try {
        const { scanQrFromSource } = await import('./qr-handoff.js');
        const bitmap = await createImageBitmap(file);
        const decoded = await scanQrFromSource(bitmap);
        if (!decoded) {
          toast.warning('No QR code detected in that image. Try taking a clearer screenshot.');
          return;
        }
        await UniversalImportDialog.handleScannedPayload(decoded, {
          dialog,
          onScannedContent: (text) => {
            tabs.show('tab-paste');
            if (pasteTextarea) {
              pasteTextarea.value = text;
              inspectAndPreview(text, 'scanned_qr_payload.txt');
            }
          }
        });
      } catch (err) {
        toast.danger('Failed to read image: ' + err.message);
      }
    });

    pasteTextarea?.addEventListener('sl-input', () => {
      inspectAndPreview(pasteTextarea.value, 'pasted_data.txt');
    });

    // Submit handler
    submitBtn?.addEventListener('click', async () => {
      if (isProcessing) return;

      // 1. If it's a student submission, route to Inbox
      if (inspectionResult?.kind === 'kbsub') {
        const { openIncomingFiles } = await import('../core/pwa.js');
        if (currentFile) {
          await openIncomingFiles([currentFile], router);
        } else {
          const fakeFile = new File([pasteTextarea.value], 'submission.kbsub', { type: 'text/plain' });
          await openIncomingFiles([fakeFile], router);
        }
        dialog.hide();
        return;
      }

      // 1b. If it's a student class join code
      if (inspectionResult?.kind === 'student_join') {
        dialog.hide();
        const { router: r } = await import('../router.js');
        const qp = inspectionResult.queryString ? `?${inspectionResult.queryString}` : `?code=${encodeURIComponent(inspectionResult.code)}`;
        (router || r).navigate(`#/student/courses${qp}`);
        return;
      }

      // 2. Educational Content (flashcards, assignment, timeline, video)
      if (!unpackedData || !unpackedData.type || !unpackedData.payload) {
        toast.warning('No valid content available to import.');
        return;
      }

      const selectedClass = classSelect.value === 'none' ? null : classSelect.value;
      const filename = inspectionResult?.filename || currentFile?.name || '';

      isProcessing = true;
      submitBtn.loading = true;

      try {
        const res = await ContentImporter.importRecordToLibrary(
          unpackedData.type,
          unpackedData.payload,
          { classId: selectedClass, filename }
        );

        toast.success(`Imported "${res.title}" into ${res.table.replace('_', ' ')}!`);

        // Dispatch global notification event
        window.dispatchEvent(new CustomEvent('kb-content-imported', {
          detail: { type: res.type, id: res.id, table: res.table }
        }));

        if (typeof onComplete === 'function') {
          onComplete(res);
        }

        await dialog.hide();
      } catch (err) {
        console.error('Import failed:', err);
        toast.danger('Import failed: ' + (err.message || 'unknown error'));
      } finally {
        isProcessing = false;
        submitBtn.loading = false;
      }
    });

    const templateMenu = dialog.querySelector('#univ-template-menu');
    templateMenu?.addEventListener('sl-select', (e) => {
      const val = e.detail?.item?.value;
      if (val === 'assignment') {
        downloadCSVTemplate('assignment_template.csv', ASSIGNMENT_CSV_TEMPLATE);
      } else if (val === 'flashcards') {
        downloadCSVTemplate('flashcards_template.csv', FLASHCARDS_CSV_TEMPLATE);
      } else if (val === 'timeline') {
        downloadCSVTemplate('timeline_template.csv', TIMELINE_CSV_TEMPLATE);
      } else if (val === 'roster') {
        downloadCSVTemplate('roster_template.csv', ROSTER_CSV_TEMPLATE);
      }
    });

    cancelBtn?.addEventListener('click', () => dialog.hide());
    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target !== dialog) return;
      dialog.remove();
    });

    await dialog.show();
    return dialog;
  }

  /**
   * Universal router for any decoded QR text across the platform
   * @param {string} rawText
   * @param {{
   *   dialog?: HTMLElement,
   *   router?: any,
   *   role?: string,
   *   onScannedContent?: (text: string) => void
   * }} [options]
   */
  static async handleScannedPayload(rawText, { dialog = null, router = null, role = null, onScannedContent = null } = {}) {
    const trimmed = String(rawText || '').trim();
    if (!trimmed) {
      toast.warning('Empty QR code.');
      return false;
    }

    const { router: globalRouter } = await import('../router.js');
    const r = router || globalRouter;

    // 0. Unwrap KBQ1 frames if passed directly
    if (trimmed.startsWith('KBQ1:')) {
      try {
        const { QrAssembler } = await import('../core/qr-transfer.js');
        const assembler = new QrAssembler({ allowSingleRaw: true });
        const rFrame = await assembler.add(trimmed);
        if (rFrame.status === 'complete' && rFrame.text) {
          return UniversalImportDialog.handleScannedPayload(rFrame.text, { dialog, router: r, role, onScannedContent });
        }
      } catch (_) {}
    }

    // 1. Direct URL or Hash Route (#/... or https://domain/#/...)
    if (trimmed.startsWith('#/') || trimmed.includes('#/')) {
      const hashIndex = trimmed.indexOf('#/');
      const hash = trimmed.slice(hashIndex);

      // 1a. Student enrollment with class code (#/student?code=...)
      if (hash.startsWith('#/student') || hash.includes('code=')) {
        try {
          const qIndex = hash.indexOf('?');
          if (qIndex >= 0) {
            const params = new URLSearchParams(hash.slice(qIndex));
            const code = params.get('code');
            if (code) {
              const { storage } = await import('../core/storage.js');
              const saved = (await storage.getMetadata('student_saved_class_codes')) || [];
              const upper = code.trim().toUpperCase();
              if (!saved.includes(upper)) {
                saved.push(upper);
                await storage.setMetadata('student_saved_class_codes', saved);
              }
              try {
                const allCourses = await storage.table('gradebook_courses').toArray().catch(() => []);
                const localCourse = allCourses.find(c => {
                  const norm = String(c.access_code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
                  return norm === upper || c.id === upper;
                });
                if (localCourse) {
                  const { buildCourseFeed } = await import('../core/course-feed.js');
                  const { mergeCourseFeed } = await import('../modules/student/course-store.js');
                  const feed = await buildCourseFeed(localCourse.id);
                  await mergeCourseFeed(feed.feed || feed.raw_payload, { accessCode: upper });
                  toast.success(`Joined class "${localCourse.name}"!`);
                } else {
                  const { joinCourseByCode } = await import('../modules/student/course-store.js');
                  await joinCourseByCode(upper);
                  toast.success(`Joined class (${upper})!`);
                }
              } catch (_) {
                toast.success(`Saved class code "${upper}"!`);
              }
            }
          }
        } catch (_) {}
        dialog?.hide();
        r.navigate(hash);
        return true;
      }

      // 1b. If scanned while an import dialog or preview is active, pass the share URL or payload to it
      if (onScannedContent && (hash.includes('#/share') || hash.includes('/share?') || hash.includes('d=') || hash.includes('ref='))) {
        onScannedContent(trimmed);
        return true;
      }

      // Default: navigate straight to the shared activity
      dialog?.hide();
      r.navigate(hash);
      return true;
    }

    // 2. Student Submission envelope (KBSUB1.)
    if (trimmed.startsWith('KBSUB1.')) {
      const { openIncomingFiles } = await import('../core/pwa.js');
      const fakeFile = new File([trimmed], 'submission.kbsub', { type: 'text/plain' });
      await openIncomingFiles([fakeFile], r);
      dialog?.hide();
      return true;
    }

    // 3. Raw class access code (short alphanumeric 3-10 chars like MATH101 or 4A7B)
    if (/^[A-Z0-9_-]{3,10}$/i.test(trimmed) && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      const { storage } = await import('../core/storage.js');
      const saved = (await storage.getMetadata('student_saved_class_codes')) || [];
      const upper = trimmed.toUpperCase();
      if (!saved.includes(upper)) {
        saved.push(upper);
        await storage.setMetadata('student_saved_class_codes', saved);
      }
      toast.success(`Added class code: ${upper}`);
      dialog?.hide();
      r.navigate('#/student');
      return true;
    }

    // 4. Content payload (.kbshare, JSON, or CSV)
    if (onScannedContent) {
      onScannedContent(trimmed);
      return true;
    }

    // Fallback: Open UniversalImportDialog with the payload pre-loaded
    UniversalImportDialog.open().then(d => {
      const tGroup = d.querySelector('#univ-import-tabs');
      const pText = d.querySelector('#univ-paste-textarea');
      tGroup?.show('tab-paste');
      if (pText) {
        pText.value = trimmed;
        pText.dispatchEvent(new CustomEvent('sl-input'));
      }
    });
    return true;
  }
}
