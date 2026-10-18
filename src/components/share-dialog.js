import { CryptoShareEngine } from '../core/crypto-share.js';
import { Sanitizer } from '../core/sanitizer.js';
import { toast } from '../utils/toast.js';

/**
 * Unified ShareModal Component
 * Provides encrypted AES-256 or unencrypted URL link generation,
 * URL length safety meter, and .kbshare file download across all modules.
 */
export class ShareModal {
  /**
   * Open the Share Dialog
   * @param {object} dataObject - Project object (flashcard deck, timeline, video assessment, etc.)
   * @param {string} moduleType - 'flashcards' | 'timeline' | 'video' | 'gradebook'
   */
  static open(dataObject, moduleType = 'flashcards') {
    if (typeof document === 'undefined') return;

    const existing = document.getElementById('kb-unified-share-dialog');
    if (existing) existing.remove();

    const title = dataObject.title || dataObject.name || 'Educational Resource';
    const safeTitle = Sanitizer.escapeHTML(title);

    const dialog = document.createElement('sl-dialog');
    dialog.id = 'kb-unified-share-dialog';
    dialog.label = `Share: ${safeTitle}`;
    dialog.className = 'kb-share-modal';

    dialog.innerHTML = `
      <div class="space-y-4 py-1">
        <p class="text-xs text-slate-500 leading-relaxed">
          KennisBoost Tools shares content directly through encrypted URLs or self-contained <code>.kbshare</code> files with <strong>zero server storage</strong>.
        </p>

        <!-- Passphrase Protection -->
        <div class="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <sl-icon name="shield-lock" class="text-blue-600"></sl-icon> Optional Passphrase Protection
            </span>
            <span class="text-[10px] text-slate-400">AES-256-GCM</span>
          </div>
          <sl-input id="input-share-passphrase" type="password" password-toggle placeholder="Leave blank for public link" size="small">
            <sl-icon name="key" slot="prefix"></sl-icon>
          </sl-input>
        </div>

        <sl-button variant="primary" id="btn-generate-share" class="w-full">
          <sl-icon slot="prefix" name="link-45deg"></sl-icon> Generate Link &amp; File
        </sl-button>

        <!-- Result Box (Hidden until generated) -->
        <div id="kb-share-results" class="hidden space-y-3 pt-2 border-t border-slate-200">
          <div class="space-y-1">
            <div class="flex items-center justify-between text-xs">
              <span class="font-medium text-slate-700">Shareable URL:</span>
              <span id="kb-url-safety-meter" class="text-[10px] px-1.5 py-0.5 rounded font-mono"></span>
            </div>
            <sl-input id="input-generated-url" readonly size="small"></sl-input>
          </div>

          <div class="flex flex-wrap gap-2 justify-end">
            <sl-button size="small" id="btn-copy-share-url" variant="primary">
              <sl-icon slot="prefix" name="clipboard-check"></sl-icon> Copy Link
            </sl-button>
            <sl-button size="small" id="btn-download-kbshare-file" variant="default">
              <sl-icon slot="prefix" name="file-earmark-arrow-down"></sl-icon> Download .kbshare
            </sl-button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(dialog);
    dialog.show();

    const passInput = dialog.querySelector('#input-share-passphrase');
    const genBtn = dialog.querySelector('#btn-generate-share');
    const resultsBox = dialog.querySelector('#kb-share-results');
    const urlInput = dialog.querySelector('#input-generated-url');
    const safetyMeter = dialog.querySelector('#kb-url-safety-meter');
    const copyBtn = dialog.querySelector('#btn-copy-share-url');
    const dlBtn = dialog.querySelector('#btn-download-kbshare-file');

    let currentPayload = null;

    const generate = async () => {
      genBtn.setAttribute('loading', '');
      try {
        const pass = passInput?.value || '';
        // Card images/audio live in this browser's storage; embed them so the deck works elsewhere
        const shareable = moduleType === 'flashcards'
          ? await (await import('../utils/media.js')).inlineDeckMedia(dataObject)
          : dataObject;
        currentPayload = await CryptoShareEngine.createSharePayload(moduleType, shareable, pass);
        urlInput.value = currentPayload.url;
        resultsBox.classList.remove('hidden');

        // Update URL safety meter
        const len = currentPayload.length;
        if (len <= 2048) {
          safetyMeter.className = 'text-[10px] px-2 py-0.5 rounded font-medium bg-emerald-50 text-emerald-700 border border-emerald-200';
          safetyMeter.textContent = `${len.toLocaleString()} / 2,048 chars — Safe for all browsers & LMS`;
        } else {
          safetyMeter.className = 'text-[10px] px-2 py-0.5 rounded font-medium bg-amber-50 text-amber-700 border border-amber-200';
          safetyMeter.textContent = `${len.toLocaleString()} chars — Large URL, .kbshare file recommended`;
          toast.warning('Payload exceeds standard 2,048 URL character limit. Use .kbshare file download for LMS uploads.');
        }
      } catch (err) {
        console.error('Share generation failed:', err);
        toast.danger('Failed to generate share payload: ' + err.message);
      } finally {
        genBtn.removeAttribute('loading');
      }
    };

    genBtn?.addEventListener('click', generate);

    copyBtn?.addEventListener('click', async () => {
      if (!urlInput?.value) return;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(urlInput.value);
        } else {
          urlInput.select();
          document.execCommand('copy');
        }
        toast.success('Share link copied to clipboard!');
      } catch (e) {
        toast.danger('Could not copy automatically. Please copy the URL manually.');
      }
    });

    dlBtn?.addEventListener('click', () => {
      if (currentPayload && currentPayload.rawFileContent) {
        const cleanName = (title || 'lesson').replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
        CryptoShareEngine.downloadKbShareFile(currentPayload.rawFileContent, `${cleanName}.kbshare`);
        toast.success('Downloaded .kbshare file!');
      }
    });

    dialog.addEventListener('sl-after-hide', (e) => {
      // Nested selects/dropdowns emit bubbling sl-after-hide events too
      if (e.target !== dialog) return;
      dialog.remove();
    });

    // Auto-generate on open
    generate();
  }
}
