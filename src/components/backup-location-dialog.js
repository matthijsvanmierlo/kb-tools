import { storage } from '../core/storage.js';
import { sync } from '../core/sync.js';
import { Sanitizer } from '../core/sanitizer.js';
import { toast } from '../utils/toast.js';
import {
  FsaFolderAdapter, GoogleDriveAdapter, OneDriveAdapter, LATEST_BACKUP_NAME,
  cloudConfig, supportsFolderAccess, backupExportedAt, isNewerThanLocal
} from '../core/storage-adapters/index.js';

const esc = (v) => Sanitizer.escapeHTML(v);

const fmtDate = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString() : 'unknown date');

function modal(label, html, buttons) {
  return new Promise((resolve) => {
    const dialog = document.createElement('sl-dialog');
    dialog.label = label;
    dialog.style.setProperty('--width', '560px');
    dialog.innerHTML = `${html}<div slot="footer" class="flex flex-wrap justify-end gap-2">${buttons
      .map(b => `<sl-button data-value="${esc(b.value)}" variant="${b.variant || 'default'}">${esc(b.label)}</sl-button>`).join('')}</div>`;
    let result = null;
    dialog.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-value]');
      if (!btn || !dialog.contains(btn)) return;
      result = btn.dataset.value;
      dialog.hide();
    });
    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target !== dialog) return;
      dialog.remove();
      resolve(result);
    });
    document.body.appendChild(dialog);
    dialog.show();
  });
}

/** Ask the teacher where backups should go; resolves with an adapter that has access, or null */
async function chooseLocation({ restoring }) {
  const cloud = cloudConfig();
  const current = sync.activeAdapter();
  const options = [];
  if (supportsFolderAccess()) {
    options.push({
      value: 'folder',
      icon: 'folder2-open',
      title: 'A folder on this computer',
      badge: 'Recommended',
      text: 'Pick a folder that Google Drive for desktop, OneDrive, ChromeOS Files → Google Drive or a school network share already syncs (or a USB stick). No sign-in needed, and backups keep running in the background.'
    });
  }
  if (cloud.google) {
    options.push({ value: 'gdrive', icon: 'google', title: 'Google Drive', text: 'Saved to a "KennisBoost Backups" folder in your school Google Drive. You will be asked to reconnect about once per session.' });
  }
  if (cloud.microsoft) {
    options.push({ value: 'onedrive', icon: 'microsoft', title: 'OneDrive', text: 'Saved to Apps/KennisBoost in your school OneDrive. Stays connected for about a day at a time.' });
  }

  if (!options.length) {
    await modal(restoring ? 'Restore from a backup location' : 'Automatic backups', `
      <p class="text-sm text-slate-700">This browser can't save to a folder automatically, and your school hasn't enabled Google Drive or OneDrive backups.</p>
      <p class="text-sm text-slate-700 mt-2">Use <strong>Export encrypted backup</strong> regularly instead (you'll be reminded), or open KennisBoost in Chrome or Edge.</p>`,
    [{ value: 'ok', label: 'OK', variant: 'primary' }]);
    return null;
  }

  const html = `
    <div class="space-y-3 text-sm">
      ${current && !restoring ? `<p class="text-xs text-slate-500">Currently backing up to <strong>${esc(current.label)}</strong>.</p>` : ''}
      <p class="text-slate-700">${restoring ? 'Where are your backups?' : 'Backups are encrypted with your recovery code before they leave this browser, so wherever they go, only you can open them.'}</p>
      ${options.map(o => `
        <button type="button" data-value="${o.value}" class="w-full text-left border border-slate-200 hover:border-blue-400 hover:bg-blue-50 rounded-xl p-3 flex gap-3 transition-colors">
          <sl-icon name="${o.icon}" class="text-xl text-blue-600 flex-shrink-0 mt-0.5"></sl-icon>
          <span>
            <span class="font-semibold text-slate-900">${esc(o.title)}</span>
            ${o.badge ? `<span class="ml-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800">${esc(o.badge)}</span>` : ''}
            <span class="block text-xs text-slate-600 mt-0.5">${esc(o.text)}</span>
          </span>
        </button>`).join('')}
    </div>`;
  const buttons = [{ value: 'cancel', label: 'Cancel' }];
  if (current && !restoring) buttons.unshift({ value: 'stop', label: 'Stop automatic backups', variant: 'text' });
  const choice = await modal(restoring ? 'Restore from a backup location' : 'Choose where backups go', html, buttons);

  if (choice === 'stop') {
    await sync.clearBackupTarget();
    toast.info('Automatic backups stopped. Remember to export backups manually.');
    return null;
  }
  try {
    let adapter = null;
    if (choice === 'folder') adapter = await FsaFolderAdapter.pick();
    else if (choice === 'gdrive') adapter = new GoogleDriveAdapter(cloud.google, storage);
    else if (choice === 'onedrive') adapter = new OneDriveAdapter(cloud.microsoft, storage);
    if (!adapter) return null;
    if (await adapter.access({ interactive: true }) !== 'granted') {
      toast.warning('KennisBoost needs permission to save there.');
      return null;
    }
    return adapter;
  } catch (err) {
    if (err?.name !== 'AbortError') toast.danger(err?.message || 'Could not open that location.');
    return null;
  }
}

async function pickBackup(adapter) {
  const backups = await sync.listLocationBackups(adapter);
  if (!backups.length) {
    await modal('No backups found', `<p class="text-sm text-slate-700">There are no KennisBoost backups in ${esc(adapter.label)} yet.</p>`,
      [{ value: 'ok', label: 'OK', variant: 'primary' }]);
    return null;
  }
  const html = `
    <div class="space-y-2 text-sm">
      <p class="text-slate-700">Choose a backup from ${esc(adapter.label)}. Daily and weekly copies let you go back to before a mistake.</p>
      ${backups.map(b => `
        <button type="button" data-value="${esc(b.name)}" class="w-full text-left border border-slate-200 hover:border-blue-400 hover:bg-blue-50 rounded-lg px-3 py-2 flex justify-between gap-3">
          <span class="font-medium text-slate-900">${esc(b.kind)}</span>
          <span class="text-xs text-slate-500 font-mono">${esc(b.name === LATEST_BACKUP_NAME ? fmtDate(b.modified) : b.name.replace(/^kennisboost-backup-(daily|weekly)-|\.json$/g, ''))}</span>
        </button>`).join('')}
    </div>`;
  const choice = await modal('Restore which backup?', html, [{ value: 'cancel', label: 'Cancel' }]);
  return choice && choice !== 'cancel' ? choice : null;
}

/**
 * Backup location dialog.
 * @param {object} opts
 * @param {(text: string, sourceName: string) => Promise<boolean>} opts.restoreFromText - decrypts,
 *   confirms and restores a backup (main.js); resolves true when data was replaced
 * @param {'setup'|'restore'} [opts.mode]
 */
export async function openBackupLocationDialog({ restoreFromText, mode = 'setup' }) {
  const restoring = mode === 'restore';
  const adapter = await chooseLocation({ restoring });
  if (!adapter) return false;

  try {
    if (restoring) {
      const name = await pickBackup(adapter);
      if (!name) return false;
      const text = await adapter.get(name);
      if (!text || !(await restoreFromText(text, `${adapter.label} · ${name}`))) return false;
      return sync.setBackupTarget(adapter);
    }

    // Don't let a fresh or older device overwrite a newer backup another device left here
    const latest = adapter.rotates ? await adapter.get(LATEST_BACKUP_NAME).catch(() => null) : null;
    if (isNewerThanLocal(latest, await storage.getMetadata('last_manual_export_timestamp'))) {
      const choice = await modal('This location already has a newer backup', `
        <div class="space-y-2 text-sm text-slate-700">
          <p>${esc(adapter.label)} contains a backup from <strong>${esc(fmtDate(backupExportedAt(latest)))}</strong>, newer than anything this browser has backed up.</p>
          <p>If you're setting up a new or reset computer, restore it first. Otherwise this browser's data becomes the new "latest" backup (older daily and weekly copies are kept).</p>
        </div>`, [
        { value: 'cancel', label: 'Cancel' },
        { value: 'overwrite', label: 'Use this browser\'s data' },
        { value: 'restore', label: 'Restore that backup', variant: 'primary' }
      ]);
      if (choice === 'restore') {
        if (!(await restoreFromText(latest, `${adapter.label} · latest`))) return false;
      } else if (choice !== 'overwrite') {
        return false;
      }
    }
    return sync.setBackupTarget(adapter);
  } catch (err) {
    console.error('Backup location failed:', err);
    toast.danger(err?.message || 'Something went wrong with that backup location.');
    return false;
  }
}

export default openBackupLocationDialog;
