import { storage } from '../core/storage.js';
import { Sanitizer } from '../core/sanitizer.js';
import { toast } from '../utils/toast.js';
import { replication, CLASS_SHARE_PREFIX } from '../core/replication/manager.js';
import { createOffer } from '../core/replication/link.js';
import { KeyVault } from '../core/keyvault.js';
import { showQrSequence, openQrScanner } from './qr-handoff.js';

const esc = (v) => Sanitizer.escapeHTML(v);
const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');

function modal(label, html, buttons, { width = '560px', onReady = null } = {}) {
  return new Promise((resolve) => {
    const dialog = document.createElement('sl-dialog');
    dialog.label = label;
    dialog.style.setProperty('--width', `min(${width}, 96vw)`);
    dialog.innerHTML = `${html}<div slot="footer" class="flex flex-wrap justify-end gap-2">${buttons
      .map(b => `<sl-button data-value="${esc(b.value)}" variant="${b.variant || 'default'}">${esc(b.label)}</sl-button>`).join('')}</div>`;
    let result = null;
    dialog.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-value]');
      if (!btn || !dialog.contains(btn)) return;
      result = { value: btn.dataset.value, dialog };
      dialog.hide();
    });
    dialog.addEventListener('sl-after-hide', (e) => {
      if (e.target !== dialog) return;
      dialog.remove();
      resolve(result);
    });
    document.body.appendChild(dialog);
    onReady?.(dialog);
    dialog.show();
  });
}

const copyBlock = (code) => `
  <details class="text-left text-xs mt-2">
    <summary class="cursor-pointer text-blue-700">No camera? Copy the code instead</summary>
    <textarea readonly class="w-full mt-2 font-mono text-[11px] border border-slate-200 rounded-lg p-2 h-24" data-code>${esc(code)}</textarea>
    <sl-button size="small" data-copy class="mt-1">Copy</sl-button>
  </details>`;

function bindCopy(dialog) {
  dialog.querySelector('[data-copy]')?.addEventListener('click', async () => {
    const text = dialog.querySelector('[data-code]')?.value || '';
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied.');
    } catch (_) {
      dialog.querySelector('[data-code]')?.select();
    }
  });
}

/** Get a code from the other screen: camera scan, or paste */
async function receiveCode({ label, intro }) {
  const choice = await modal(label, `
    <div class="space-y-3 text-sm">
      <p class="text-slate-700">${esc(intro)}</p>
      <sl-textarea id="dv-paste" rows="3" placeholder="…or paste the code here" class="font-mono"></sl-textarea>
    </div>`, [
    { value: 'cancel', label: 'Cancel' },
    { value: 'scan', label: 'Scan with camera' },
    { value: 'paste', label: 'Use pasted code', variant: 'primary' }
  ]);
  if (!choice || choice.value === 'cancel') return null;
  if (choice.value === 'paste') {
    const text = choice.dialog.querySelector('#dv-paste')?.value?.trim();
    return text || null;
  }
  return new Promise((resolve) => {
    let got = null;
    openQrScanner({
      label,
      once: true,
      readyText: 'Point the camera at the code on the other screen.',
      noCamera: 'This browser cannot use the camera. Paste the code instead.',
      onSubmission: (text) => { got = text; },
      onClose: () => resolve(got)
    });
  });
}

async function confirmSafety(safety, what) {
  const r = await modal('Check the safety number', `
    <div class="space-y-3 text-sm text-center">
      <p class="text-slate-700">The other screen should show the same number:</p>
      <p class="text-3xl font-mono font-bold tracking-widest">${esc(safety)}</p>
      <p class="text-xs text-slate-500">If the numbers differ, someone may have swapped a code. Cancel and start again.</p>
    </div>`, [
    { value: 'no', label: 'They differ' },
    { value: 'yes', label: `They match: ${what}`, variant: 'primary' }
  ], { width: '440px' });
  return r?.value === 'yes';
}

function showAnswer(code, safety, intro) {
  return showQrSequence(code, {
    label: 'Show this to the other device',
    intro,
    ariaLabel: 'Encrypted reply code',
    hint: `Safety number: ${safety}. Scan these codes with the other device{multi}, then check it shows the same safety number.`,
    footerHtml: copyBlock(code),
    onReady: bindCopy
  });
}

async function showOffer(offer, { label, intro }) {
  return modal(label, `
    <div class="space-y-3 text-sm text-center">
      <p class="text-slate-700">${esc(intro)}</p>
      <div class="kb-qr-frame mx-auto" data-qr></div>
      ${copyBlock(offer.code)}
    </div>`, [
    { value: 'cancel', label: 'Cancel' },
    { value: 'next', label: 'Next: receive the reply', variant: 'primary' }
  ], {
    onReady: async (d) => {
      const { renderQrSvg } = await import('./qr-handoff.js');
      const { encodeQrFrames } = await import('../core/qr-transfer.js');
      d.querySelector('[data-qr]').innerHTML = renderQrSvg((await encodeQrFrames(offer.code))[0]);
      bindCopy(d);
    }
  });
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

async function linkNewDevice() {
  const offerCode = await receiveCode({
    label: 'Link a new device',
    intro: 'On the new device, open Backup & storage → Devices & sharing → "Set up this device from another one". Then scan or paste the code it shows.'
  });
  if (!offerCode) return;
  try {
    const { code, safety } = await replication.answerDeviceLink(offerCode);
    await showAnswer(code, safety, 'The new device gets your submission key, recovery code and sync settings, encrypted for that device only.');
  } catch (err) {
    toast.danger(err.message || 'Could not link the device.');
  }
}

async function setUpFromOtherDevice() {
  const offer = await createOffer('device');
  const step = await showOffer(offer, {
    label: 'Set up this device',
    intro: 'On your other device, open Backup & storage → Devices & sharing → "Link a new device" and scan this code.'
  });
  if (step?.value !== 'next') return;
  const answer = await receiveCode({ label: 'Receive the reply', intro: 'Scan or paste the reply your other device shows.' });
  if (!answer) return;
  try {
    const link = await replication.openDeviceLink(offer, answer);
    if (!(await confirmSafety(link.safety, 'link this device'))) return;
    const { status, needsLocation } = await link.apply();
    toast.success('This device is now linked. It can open your hand-ins and backups.');
    if (needsLocation) {
      toast.info('Choose the same backup location as on your other device to start syncing.', 10000);
      window.dispatchEvent(new CustomEvent('kb-open-backup-location'));
    } else if (status.state === 'error') {
      toast.warning(status.error);
    }
    window.dispatchEvent(new CustomEvent('kb-remote-changes'));
  } catch (err) {
    toast.danger(err.message || 'Could not link this device.');
  }
}

async function shareClass() {
  const courses = (await storage.table('gradebook_courses').toArray()).filter(c => !c.archived_at && !c.is_demo);
  if (!courses.length) {
    toast.info('Create a class first.');
    return;
  }
  const pick = await modal('Share a class with a co-teacher', `
    <div class="space-y-3 text-sm">
      <p class="text-slate-700">Your co-teacher gets this class's roster, gradebook and assignments, and can open work students hand in for it from now on. Your other classes stay private.</p>
      <sl-select id="dv-course" label="Class" value="${esc(courses[0].id)}">
        ${courses.map(c => `<sl-option value="${esc(c.id)}">${esc(c.name)}${c.section ? ` · ${esc(c.section)}` : ''}</sl-option>`).join('')}
      </sl-select>
      <p class="text-xs text-slate-500">Both of you need to be connected to the same school server. Assignments published before sharing stay readable only by you; republish them to include your co-teacher.</p>
    </div>`, [{ value: 'cancel', label: 'Cancel' }, { value: 'next', label: 'Next', variant: 'primary' }]);
  if (pick?.value !== 'next') return;
  const course = courses.find(c => c.id === pick.dialog.querySelector('#dv-course').value);
  const offerCode = await receiveCode({
    label: 'Scan your co-teacher\'s code',
    intro: 'Ask your co-teacher to open Devices & sharing → "Join a co-teacher\'s class", then scan or paste the code they show.'
  });
  if (!offerCode) return;
  try {
    const { code, safety } = await replication.answerClassInvite(course, offerCode);
    await showAnswer(code, safety, `Invite for ${course.name}. It contains the class key, encrypted for your co-teacher's device only.`);
  } catch (err) {
    toast.danger(err.message || 'Could not create the invite.');
  }
}

async function joinClass() {
  const offer = await createOffer('coteacher');
  const step = await showOffer(offer, {
    label: 'Join a co-teacher\'s class',
    intro: 'Show this code to the teacher who owns the class. They scan it under Devices & sharing → "Share a class with a co-teacher".'
  });
  if (step?.value !== 'next') return;
  const answer = await receiveCode({ label: 'Receive the invite', intro: 'Scan or paste the invite your co-teacher shows.' });
  if (!answer) return;
  try {
    const invite = await replication.openClassInvite(offer, answer);
    if (!(await confirmSafety(invite.safety, `join ${invite.course.name || 'the class'}`))) return;
    const status = await invite.apply();
    if (status.state === 'error') toast.warning(status.error);
    else toast.success(`You now share ${invite.course.name || 'the class'}.`);
    window.dispatchEvent(new CustomEvent('kb-remote-changes'));
  } catch (err) {
    toast.danger(err.message || 'Could not join the class.');
  }
}

async function reviewConflicts() {
  const list = await replication.conflicts();
  if (!list.length) return;
  const describe = (g) => (g ? `${g.raw_score ?? g.score ?? '—'}${g.status ? ` (${g.status})` : ''}` : 'deleted');
  const r = await modal('Grades changed on two devices', `
    <div class="space-y-2 text-sm">
      <p class="text-slate-700">These grades were edited on two devices before they synced. The newest edit was kept; you can switch to the other one.</p>
      ${list.map(c => `
        <div class="border border-slate-200 rounded-lg p-2 flex items-center justify-between gap-2">
          <span class="text-xs"><span class="font-mono">${esc(Array.isArray(c.key) ? c.key.join(' · ') : c.key)}</span><br>
            kept <strong>${esc(describe(c.kept))}</strong>, other version <strong>${esc(describe(c.discarded))}</strong></span>
          <span class="flex gap-1">
            <sl-button size="small" data-resolve="${esc(c.id)}" data-use="kept">Keep</sl-button>
            <sl-button size="small" data-resolve="${esc(c.id)}" data-use="discarded">Use other</sl-button>
          </span>
        </div>`).join('')}
    </div>`, [{ value: 'close', label: 'Close' }], {
    onReady: (d) => d.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-resolve]');
      if (!btn) return;
      await replication.resolveConflict(btn.dataset.resolve, { useDiscarded: btn.dataset.use === 'discarded' });
      btn.closest('.border')?.remove();
    })
  });
  return r;
}

/** Backup & storage → Devices & sharing */
export async function openDevicesDialog() {
  const ws = await replication.workspace();
  const status = replication.status;
  const shares = [];
  for (const name of await KeyVault.listSecretNames(storage, CLASS_SHARE_PREFIX)) {
    const s = await KeyVault.getSecret(storage, name);
    if (s) shares.push(s);
  }
  const channelText = !ws ? 'Not set up yet'
    : ws.channel.type === 'relay' ? 'Through your school server'
      : ws.channel.type === 'location' ? 'Through your backup location'
        : 'Keys only (no automatic sync: set up a backup location or school server)';
  const conflicts = (await replication.conflicts()).length;

  const r = await modal('Devices & sharing', `
    <div class="space-y-5 text-sm">
      <section class="space-y-2">
        <h3 class="font-semibold text-slate-900">Your devices</h3>
        <p class="text-xs text-slate-600">${esc(channelText)} · last sync ${esc(fmt(status.lastSyncAt))}${status.state === 'error' ? ` · <span class="text-red-700">${esc(status.error)}</span>` : ''}</p>
        <p class="text-xs text-slate-500">Linked devices share your submission key and recovery code, and keep classes, grades and materials in sync. Everything is encrypted before it leaves a device.</p>
        <div class="flex flex-wrap gap-2">
          <sl-button size="small" data-value="link"><sl-icon slot="prefix" name="phone"></sl-icon>Link a new device</sl-button>
          <sl-button size="small" data-value="setup"><sl-icon slot="prefix" name="laptop"></sl-icon>Set up this device from another one</sl-button>
          ${ws && ws.channel.type !== 'none' ? '<sl-button size="small" data-value="sync"><sl-icon slot="prefix" name="arrow-repeat"></sl-icon>Sync now</sl-button>' : ''}
          ${conflicts ? `<sl-button size="small" variant="warning" data-value="conflicts">Review ${conflicts} grade conflict${conflicts === 1 ? '' : 's'}</sl-button>` : ''}
        </div>
      </section>
      <section class="space-y-2">
        <h3 class="font-semibold text-slate-900">Co-teaching</h3>
        ${shares.length ? `<ul class="space-y-1">${shares.map(s => `
          <li class="flex items-center justify-between gap-2 border border-slate-200 rounded-lg px-3 py-1.5">
            <span>${esc(s.course_name || s.course_id)} <span class="text-xs text-slate-500">${s.owner ? '(you shared it)' : '(shared with you)'}</span></span>
            <sl-button size="small" variant="text" data-stop="${esc(s.course_id)}">Stop sharing</sl-button>
          </li>`).join('')}</ul>` : '<p class="text-xs text-slate-500">Share one class (roster, gradebook, assignments) with another teacher. Needs a school server.</p>'}
        <div class="flex flex-wrap gap-2">
          <sl-button size="small" data-value="share"><sl-icon slot="prefix" name="people"></sl-icon>Share a class with a co-teacher</sl-button>
          <sl-button size="small" data-value="join"><sl-icon slot="prefix" name="box-arrow-in-right"></sl-icon>Join a co-teacher's class</sl-button>
        </div>
      </section>
    </div>`, [{ value: 'close', label: 'Close' }], {
    width: '600px',
    onReady: (d) => d.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-stop]');
      if (!btn) return;
      await replication.stopSharing(btn.dataset.stop);
      toast.info('Stopped sharing that class on your devices.');
      d.hide();
    })
  });

  switch (r?.value) {
    case 'link': return linkNewDevice();
    case 'setup': return setUpFromOtherDevice();
    case 'share': return shareClass();
    case 'join': return joinClass();
    case 'conflicts': return reviewConflicts();
    case 'sync': {
      const s = await replication.syncNow();
      if (s.state === 'error') toast.warning(s.error);
      else toast.success('Synced.');
      return null;
    }
    default: return null;
  }
}

export default openDevicesDialog;
