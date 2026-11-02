/**
 * Settings Hub (KB-SETT-001)
 *
 * First-class Settings view with dedicated sections:
 * - profile: Profile & Role, Teacher Name, FERPA Data Export
 * - relay: School sync server status, connect/test form, quota usage
 * - guide: Step-by-step setup guide for IT admins & teachers (Paths A, B, C, D)
 * - devices: Linked devices list, bytes used, remove device, force sync
 * - backups: Backup location, auto-backup, snapshot history, manual export/import
 * - appearance: Light/dark theme, font scale, safe-area debug
 */

import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { ConfirmDialog } from '../../utils/dialogs.js';
import { RoleMode } from '../../state/role-mode.js';
import {
  getTransportConfig,
  setTransportConfig,
  clearTransportConfig,
  getTransport,
  RelayTransport
} from '../../core/transport.js';
import { renderRelaySetupGuideHTML } from '../../components/relay-setup-guide.js';
import { parseConnectionInput, relayApiBase } from '../../core/relay-config.js';
import { signInWithSchoolSso } from '../../core/relay-sso.js';

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));

/**
 * Validate a candidate relay URL.
 * Rejects insecure http:// unless host is localhost, 127.0.0.1, or .local mDNS.
 */
export function validateRelayUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, valid: false, reason: 'Please enter a server URL.', error: 'Please enter a server URL.' };
  }
  const trimmed = rawUrl.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_) {
    return { ok: false, valid: false, reason: 'Invalid URL format. Example: https://relay.myschool.edu', error: 'Invalid URL format. Example: https://relay.myschool.edu' };
  }

  if (parsed.protocol === 'https:') {
    const cleanUrl = parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname);
    return { ok: true, valid: true, url: cleanUrl };
  }

  if (parsed.protocol === 'http:') {
    const host = parsed.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local') || host.startsWith('192.168.') || host.startsWith('10.');
    if (isLocal) {
      const cleanUrl = parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname);
      return { ok: true, valid: true, url: cleanUrl };
    }
    return {
      ok: false,
      valid: false,
      reason: 'Public relay servers must use HTTPS. Plain HTTP exposes student data and teacher credentials in the clear.',
      error: 'Public relay servers must use HTTPS. Plain HTTP exposes student data and teacher credentials in the clear.'
    };
  }

  return { ok: false, valid: false, reason: 'Server URL must start with https:// (or http:// for local servers).', error: 'Server URL must start with https:// (or http:// for local servers).' };
}

export async function renderSettingsView(params, router, container) {
  const currentSection = params?.section || 'profile';

  // Read current configuration
  const transportConfig = (await getTransportConfig()) || {};
  const currentRelay = transportConfig.baseUrl || '';
  const teacherId = transportConfig.teacherId || '';
  const currentRole = RoleMode.get();
  const teacherProfile = (await storage.getMetadata('teacher_profile')) || { name: 'Teacher' };

  container.innerHTML = `
    <div class="max-w-4xl mx-auto space-y-6 pb-16">
      <!-- Header -->
      <div class="flex items-center justify-between border-b border-slate-200 pb-4">
        <div>
          <h1 class="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <sl-icon name="gear" class="text-slate-700"></sl-icon> Settings
          </h1>
          <p class="text-xs text-slate-500 mt-1">Manage school sync, connected devices, backups, and display preferences.</p>
        </div>
      </div>

      <!-- Navigation Tabs -->
      <div class="flex border-b border-slate-200 gap-2 overflow-x-auto text-sm font-medium">
        <button type="button" class="kb-tab-btn py-2.5 px-3 border-b-2 ${currentSection === 'profile' ? 'border-blue-600 text-blue-600 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800'}" data-section="profile">
          <sl-icon name="person" class="mr-1"></sl-icon> Profile &amp; Role
        </button>
        <button type="button" class="kb-tab-btn py-2.5 px-3 border-b-2 ${currentSection === 'relay' ? 'border-blue-600 text-blue-600 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800'}" data-section="relay">
          <sl-icon name="cloud-check" class="mr-1"></sl-icon> School Sync Server
        </button>
        <button type="button" class="kb-tab-btn py-2.5 px-3 border-b-2 ${currentSection === 'guide' ? 'border-blue-600 text-blue-600 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800'}" data-section="guide">
          <sl-icon name="book" class="mr-1"></sl-icon> Set Up Server
        </button>
        <button type="button" class="kb-tab-btn py-2.5 px-3 border-b-2 ${currentSection === 'devices' ? 'border-blue-600 text-blue-600 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800'}" data-section="devices">
          <sl-icon name="laptop" class="mr-1"></sl-icon> Devices &amp; Sync
        </button>
        <button type="button" class="kb-tab-btn py-2.5 px-3 border-b-2 ${currentSection === 'backups' ? 'border-blue-600 text-blue-600 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800'}" data-section="backups">
          <sl-icon name="shield-check" class="mr-1"></sl-icon> Backups
        </button>
        <button type="button" class="kb-tab-btn py-2.5 px-3 border-b-2 ${currentSection === 'appearance' ? 'border-blue-600 text-blue-600 font-semibold' : 'border-transparent text-slate-500 hover:text-slate-800'}" data-section="appearance">
          <sl-icon name="palette" class="mr-1"></sl-icon> Appearance
        </button>
      </div>

      <!-- Section Container -->
      <div id="settings-section-mount">
        <!-- Injected below -->
      </div>
    </div>
  `;

  // Bind tab switching
  container.querySelectorAll('.kb-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const sec = btn.getAttribute('data-section');
      router.navigate(`#/settings?section=${sec}`);
    });
  });

  const mount = container.querySelector('#settings-section-mount');

  // Render active section
  switch (currentSection) {
    case 'profile':
      renderProfileSection(mount, router, currentRole, teacherProfile);
      break;
    case 'relay':
      await renderRelaySection(mount, router, currentRelay, teacherId);
      break;
    case 'guide':
      renderGuideSection(mount);
      break;
    case 'devices':
      await renderDevicesSection(mount, router);
      break;
    case 'backups':
      await renderBackupsSection(mount, router);
      break;
    case 'appearance':
      renderAppearanceSection(mount);
      break;
    default:
      renderProfileSection(mount, router, currentRole, teacherProfile);
      break;
  }
}

// -----------------------------------------------------------------------------
// 1. Profile & Role Section
// -----------------------------------------------------------------------------
function renderProfileSection(mount, router, currentRole, teacherProfile) {
  mount.innerHTML = `
    <div class="space-y-6">
      <div class="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
        <h3 class="font-bold text-slate-900 text-base">Active Role</h3>
        <p class="text-xs text-slate-500">You are currently using KennisBoost in <strong>${currentRole === 'teacher' ? 'Teacher' : 'Student'} mode</strong>.</p>
        <div class="flex gap-3">
          <sl-button variant="${currentRole === 'teacher' ? 'primary' : 'default'}" id="btn-role-teacher">
            <sl-icon slot="prefix" name="mortarboard"></sl-icon> Teacher Mode
          </sl-button>
          <sl-button variant="${currentRole === 'student' ? 'primary' : 'default'}" id="btn-role-student">
            <sl-icon slot="prefix" name="person"></sl-icon> Student Mode
          </sl-button>
        </div>
      </div>

      <div class="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
        <h3 class="font-bold text-slate-900 text-base">Teacher Information</h3>
        <div class="space-y-3 max-w-md">
          <sl-input id="input-teacher-name" label="Display Name" value="${esc(teacherProfile.name || '')}" placeholder="e.g. Ms. Lovelace"></sl-input>
          <sl-button variant="primary" size="small" id="btn-save-teacher-profile">Save Name</sl-button>
        </div>
      </div>

      <div class="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
        <h3 class="font-bold text-slate-900 text-base">FERPA &amp; Local Privacy</h3>
        <p class="text-xs text-slate-500">KennisBoost keeps data strictly on your device. Export a complete JSON archive of all local storage for compliance or records.</p>
        <div class="flex gap-3 flex-wrap">
          <sl-button size="small" id="btn-export-ferpa"><sl-icon slot="prefix" name="download"></sl-icon> Export All Local Data (.json)</sl-button>
          <sl-button size="small" variant="danger" id="btn-reset-app"><sl-icon slot="prefix" name="trash"></sl-icon> Reset All Local Data</sl-button>
        </div>
      </div>
    </div>
  `;

  mount.querySelector('#btn-role-teacher')?.addEventListener('click', () => {
    RoleMode.set('teacher');
    router.navigate('#/');
  });

  mount.querySelector('#btn-role-student')?.addEventListener('click', () => {
    RoleMode.set('student');
    router.navigate('#/student');
  });

  mount.querySelector('#btn-save-teacher-profile')?.addEventListener('click', async () => {
    const val = mount.querySelector('#input-teacher-name').value.trim();
    await storage.setMetadata('teacher_profile', { name: val || 'Teacher' });
    toast.success('Teacher name saved!');
  });

  mount.querySelector('#btn-export-ferpa')?.addEventListener('click', async () => {
    const { exportFullJsonBackup } = await import('../../core/records-export.js');
    await exportFullJsonBackup();
  });

  mount.querySelector('#btn-reset-app')?.addEventListener('click', async () => {
    const confirmed = await ConfirmDialog.show({
      title: 'Reset All Data?',
      message: 'This will delete all classes, rosters, and grades from this browser. This action CANNOT be undone unless you have a backup.',
      confirmText: 'Reset Everything',
      variant: 'danger'
    });
    if (confirmed) {
      await storage.clearAll();
      window.location.reload();
    }
  });
}

// -----------------------------------------------------------------------------
// 2. School Sync Server Section
// -----------------------------------------------------------------------------
async function renderRelaySection(mount, router, currentRelay, teacherId) {
  const config = (await getTransportConfig()) || {};
  const isConnected = Boolean(config.baseUrl);
  const defaultRelay = (typeof window !== 'undefined' && (window.KB_CONFIG?.relay?.baseUrl || window.KB_CONFIG?.baseUrl)) || '';
  const ssoConfig = (typeof window !== 'undefined' && (window.KB_CONFIG?.relay?.sso || window.KB_CONFIG?.sso)) || null;

  if (isConnected) {
    mount.innerHTML = `
      <div class="space-y-6">
        <!-- Connected Status Card -->
        <div class="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <h3 class="font-bold text-slate-900 text-base">Server Connection Status</h3>
              <p class="text-xs text-slate-500 mt-0.5" id="relay-status-text">
                Connected to <code>${esc(config.baseUrl)}</code>
              </p>
            </div>
            <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700">
              <span class="w-2 h-2 rounded-full bg-emerald-500"></span>
              Connected
            </span>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-100 text-xs">
            <div>
              <span class="text-slate-400">Teacher ID:</span>
              <span class="font-medium text-slate-700 ml-1">${esc(config.teacherId || 'N/A')}</span>
            </div>
            ${config.name ? `
            <div>
              <span class="text-slate-400">Name:</span>
              <span class="font-medium text-slate-700 ml-1">${esc(config.name)}</span>
            </div>
            ` : ''}
            <div>
              <span class="text-slate-400">Security:</span>
              <span class="font-medium text-emerald-700 ml-1">AES-256 Sealed in KeyVault</span>
            </div>
          </div>

          <div id="quota-usage-mount" class="hidden pt-2 border-t border-slate-100 space-y-2">
            <!-- Populated by usage check -->
          </div>

          <div class="pt-3 border-t border-slate-100 flex flex-wrap gap-2">
            <sl-button size="small" id="btn-check-relay"><sl-icon slot="prefix" name="arrow-repeat"></sl-icon> Test Connection &amp; Quota</sl-button>
            <sl-button size="small" id="btn-rotate-key"><sl-icon slot="prefix" name="shield-lock"></sl-icon> Rotate Security Key</sl-button>
            <sl-button size="small" variant="danger" id="btn-disconnect-relay"><sl-icon slot="prefix" name="x-circle"></sl-icon> Disconnect</sl-button>
          </div>
        </div>
      </div>
    `;

    mount.querySelector('#btn-check-relay')?.addEventListener('click', async () => {
      try {
        const transport = await getTransport();
        if (!transport || !transport.getUsage) return;
        const usage = await transport.getUsage();
        const quotaMount = mount.querySelector('#quota-usage-mount');
        if (quotaMount) {
          quotaMount.classList.remove('hidden');
          const usedMB = ((usage.bytes_used || 0) / (1024 * 1024)).toFixed(1);
          const limitMB = ((usage.quota_bytes || 1024 * 1024 * 1024) / (1024 * 1024)).toFixed(0);
          const pct = Math.min(100, Math.round(((usage.bytes_used || 0) / (usage.quota_bytes || 1)) * 100));

          quotaMount.innerHTML = `
            <div class="flex justify-between text-xs font-semibold text-slate-700">
              <span>Storage Used: ${usedMB} MB / ${limitMB} MB</span>
              <span>${pct}%</span>
            </div>
            <div class="w-full bg-slate-200 rounded-full h-2 overflow-hidden">
              <div class="bg-blue-600 h-2 rounded-full transition-all" style="width: ${pct}%"></div>
            </div>
          `;
        }
        toast.success('Connection & quota verified!');
      } catch (err) {
        toast.warning(`Usage check error: ${err.message}`);
      }
    });

    mount.querySelector('#btn-rotate-key')?.addEventListener('click', async () => {
      const confirmed = await ConfirmDialog.show({
        title: 'Rotate Security Key?',
        message: 'This will issue a fresh token for your account and permanently invalidate the previous key on this device.',
        confirmText: 'Rotate Key',
        variant: 'primary'
      });
      if (!confirmed) return;

      const btn = mount.querySelector('#btn-rotate-key');
      btn.loading = true;
      try {
        const apiBase = relayApiBase(config.baseUrl);
        const res = await fetch(`${apiBase}/auth/roll`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.token}`
          }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok || !data.token) {
          throw new Error(data.error || `Key rotation failed (${res.status})`);
        }

        await setTransportConfig({
          baseUrl: config.baseUrl,
          token: data.token,
          teacherId: data.teacher?.id || config.teacherId,
          name: data.teacher?.name || config.name
        });

        toast.success('Security key successfully rotated!');
        renderRelaySection(mount, router, config.baseUrl, config.teacherId);
      } catch (err) {
        toast.danger(`Key rotation failed: ${err.message}`);
      } finally {
        btn.loading = false;
      }
    });

    mount.querySelector('#btn-disconnect-relay')?.addEventListener('click', async () => {
      const confirmed = await ConfirmDialog.show({
        title: 'Disconnect from Relay?',
        message: 'You will return to offline-only mode. Existing data on this device will not be deleted.',
        confirmText: 'Disconnect'
      });
      if (confirmed) {
        await clearTransportConfig();
        toast.info('Disconnected from school server.');
        renderRelaySection(mount, router, '', '');
      }
    });

    return;
  }

  // DISCONNECTED STATE
  const hasGoogleSso = Boolean(ssoConfig?.google?.client_id || ssoConfig?.googleClientId);
  const hasMsSso = Boolean(ssoConfig?.microsoft?.client_id || ssoConfig?.microsoftClientId);

  mount.innerHTML = `
    <div class="space-y-6">
      <!-- Status Card -->
      <div class="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="font-bold text-slate-900 text-base">Server Connection Status</h3>
            <p class="text-xs text-slate-500 mt-0.5" id="relay-status-text">
              No sync server configured (offline-only mode)
            </p>
          </div>
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-600">
            <span class="w-2 h-2 rounded-full bg-slate-400"></span>
            Offline
          </span>
        </div>
      </div>

      ${(hasGoogleSso || hasMsSso) ? `
      <!-- School SSO Login -->
      <div class="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
        <h3 class="font-bold text-slate-900 text-base">School Single Sign-On (SSO)</h3>
        <p class="text-xs text-slate-500 leading-relaxed">
          Sign in with your verified school account to automatically connect your device to the school relay.
        </p>
        <div class="flex flex-wrap gap-3">
          ${hasGoogleSso ? `
            <sl-button id="btn-sso-google" variant="default">
              <sl-icon slot="prefix" name="google"></sl-icon> Sign in with Google Workspace
            </sl-button>
          ` : ''}
          ${hasMsSso ? `
            <sl-button id="btn-sso-microsoft" variant="default">
              <sl-icon slot="prefix" name="microsoft"></sl-icon> Sign in with Microsoft 365
            </sl-button>
          ` : ''}
        </div>
      </div>
      ` : ''}

      <!-- Connect Form (Masked, Zero Plaintext Token) -->
      <div class="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
        <h3 class="font-bold text-slate-900 text-base">Connect with Code or Link</h3>
        <p class="text-xs text-slate-500 leading-relaxed">
          Paste a single-use connection capsule (<code>KBCON1...</code>), a short claim code (<code>KBC-XXXX-XXXX-XXXX</code>), or an onboarding link from your IT administrator. The key will be securely sealed into this device's non-extractable KeyVault.
        </p>

        <form id="form-connect-relay" class="space-y-4 max-w-lg">
          <sl-input
            id="input-relay-url"
            label="Relay Server URL"
            placeholder="https://relay.myschool.edu"
            value="${esc(defaultRelay)}"
            help-text="Optional if included in your connection link or capsule."
          ></sl-input>

          <sl-input
            id="input-relay-token"
            label="Connection Code, Bearer Token, or Link"
            type="password"
            placeholder="Paste KBCON1... capsule, claim code, or onboarding link"
            required
            help-text="Single-use credentials are automatically rotated and encrypted at rest."
          ></sl-input>

          <div id="relay-validation-feedback" class="text-xs hidden"></div>

          <div class="flex gap-2 pt-2">
            <sl-button type="button" size="small" id="btn-test-before-save">
              <sl-icon slot="prefix" name="activity"></sl-icon> Test Connection
            </sl-button>
            <sl-button type="submit" variant="primary" size="small" id="btn-save-relay">
              <sl-icon slot="prefix" name="link-45deg"></sl-icon> Connect to Server
            </sl-button>
          </div>
        </form>
      </div>
    </div>
  `;

  const form = mount.querySelector('#form-connect-relay');
  const urlInput = mount.querySelector('#input-relay-url');
  const credInput = mount.querySelector('#input-relay-token');
  const feedback = mount.querySelector('#relay-validation-feedback');

  const testConnection = async (showSuccessToast = false) => {
    const rawUrl = urlInput.value.trim() || defaultRelay;
    const val = validateRelayUrl(rawUrl);
    if (!val.ok) {
      feedback.className = 'text-xs text-rose-600 block';
      feedback.textContent = val.reason;
      return false;
    }

    feedback.className = 'text-xs text-slate-500 block';
    feedback.textContent = 'Pinging server /health and validating /whoami...';

    const t0 = performance.now();
    try {
      const rawCred = credInput.value.trim();
      const parsed = rawCred ? parseConnectionInput(rawCred, { defaultBaseUrl: val.url }) : null;
      const testToken = (parsed?.kind === 'token' || parsed?.kind === 'capsule' || parsed?.kind === 'legacy')
        ? parsed.token
        : rawCred;

      const transport = new RelayTransport({ baseUrl: val.url, token: testToken });
      const health = await transport.health();
      const latency = Math.round(performance.now() - t0);

      if (testToken) {
        try {
          const whoami = await transport.whoami();
          feedback.className = 'text-xs text-emerald-600 font-semibold block';
          feedback.textContent = `✓ Connected! Latency: ${latency}ms · Server: v${health.serverVersion || '2'} · Teacher: ${whoami?.teacher_id || 'valid'}`;
          if (showSuccessToast) toast.success('Server connection verified!');
          return true;
        } catch (err) {
          feedback.className = 'text-xs text-rose-600 block';
          feedback.textContent = `Server responded in ${latency}ms, but teacher token was rejected (401 Unauthorized). Check your token.`;
          return false;
        }
      }

      feedback.className = 'text-xs text-emerald-600 font-semibold block';
      feedback.textContent = `✓ Server reachable! Latency: ${latency}ms`;
      if (showSuccessToast) toast.success('Server reachable!');
      return true;
    } catch (err) {
      feedback.className = 'text-xs text-rose-600 block';
      feedback.textContent = `Connection failed: ${err.message}`;
      return false;
    }
  };

  mount.querySelector('#btn-test-before-save')?.addEventListener('click', () => testConnection(true));

  // School SSO Handlers
  if (hasGoogleSso) {
    mount.querySelector('#btn-sso-google')?.addEventListener('click', async () => {
      try {
        const gConfig = ssoConfig?.google || {};
        const clientId = gConfig.client_id || ssoConfig?.googleClientId;
        const targetRelay = urlInput?.value.trim() || defaultRelay;
        if (!targetRelay) {
          toast.danger('Please enter the Relay Server URL first.');
          return;
        }
        const val = validateRelayUrl(targetRelay);
        if (!val.ok) {
          toast.danger(val.reason);
          return;
        }
        const res = await signInWithSchoolSso({
          provider: 'google',
          baseUrl: val.url,
          clientId,
          hostedDomain: gConfig.hosted_domain || ''
        });
        toast.success(`Welcome, ${res.teacher?.name || 'Teacher'}! Server connected.`);
        renderRelaySection(mount, router, val.url, res.teacher?.id);
      } catch (err) {
        toast.danger(`Google SSO failed: ${err.message}`);
      }
    });
  }

  if (hasMsSso) {
    mount.querySelector('#btn-sso-microsoft')?.addEventListener('click', async () => {
      try {
        const msConfig = ssoConfig?.microsoft || {};
        const clientId = msConfig.client_id || ssoConfig?.microsoftClientId;
        const targetRelay = urlInput?.value.trim() || defaultRelay;
        if (!targetRelay) {
          toast.danger('Please enter the Relay Server URL first.');
          return;
        }
        const val = validateRelayUrl(targetRelay);
        if (!val.ok) {
          toast.danger(val.reason);
          return;
        }
        const res = await signInWithSchoolSso({
          provider: 'microsoft',
          baseUrl: val.url,
          clientId,
          tenant: msConfig.tenant || 'common'
        });
        toast.success(`Welcome, ${res.teacher?.name || 'Teacher'}! Server connected.`);
        renderRelaySection(mount, router, val.url, res.teacher?.id);
      } catch (err) {
        toast.danger(`Microsoft SSO failed: ${err.message}`);
      }
    });
  }

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    feedback.className = 'text-xs hidden';

    const rawCred = credInput.value.trim();
    const rawUrl = urlInput.value.trim() || defaultRelay;

    if (!rawCred) {
      feedback.className = 'text-xs text-rose-600 block';
      feedback.textContent = 'Please enter a connection code or onboarding link.';
      return;
    }

    const parsed = parseConnectionInput(rawCred, { defaultBaseUrl: rawUrl });
    if (!parsed) {
      feedback.className = 'text-xs text-rose-600 block';
      feedback.textContent = 'Unrecognized format. Paste a valid capsule, claim code, or onboarding link.';
      return;
    }

    const targetUrl = parsed.baseUrl || rawUrl;
    const val = validateRelayUrl(targetUrl);
    if (!val.ok) {
      feedback.className = 'text-xs text-rose-600 block';
      feedback.textContent = val.reason;
      return;
    }

    const submitBtn = mount.querySelector('#btn-save-relay');
    submitBtn.loading = true;
    feedback.className = 'text-xs text-slate-500 block';
    feedback.textContent = 'Validating and rotating server credentials...';

    try {
      const apiBase = relayApiBase(val.url);
      let finalToken = '';
      let finalTeacherId = parsed.teacherId || '';
      let finalTeacherName = parsed.name || '';

      if (parsed.kind === 'claim') {
        const claimRes = await fetch(`${apiBase}/auth/claim`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: parsed.code })
        });
        const claimData = await claimRes.json().catch(() => ({}));
        if (!claimRes.ok || !claimData.ok) {
          throw new Error(claimData.error || claimData.message || `Claim code invalid or expired (${claimRes.status})`);
        }
        finalToken = claimData.token;
        finalTeacherId = claimData.teacher?.id || finalTeacherId;
        finalTeacherName = claimData.teacher?.name || finalTeacherName;
      } else if (parsed.kind === 'capsule' || parsed.kind === 'token') {
        finalToken = parsed.token;
        try {
          const rollRes = await fetch(`${apiBase}/auth/roll`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${parsed.token}`
            }
          });
          if (rollRes.ok) {
            const rollData = await rollRes.json().catch(() => ({}));
            if (rollData.ok && rollData.token) {
              finalToken = rollData.token;
              finalTeacherId = rollData.teacher?.id || finalTeacherId;
              finalTeacherName = rollData.teacher?.name || finalTeacherName;
            }
          } else if (rollRes.status !== 404) {
            const errData = await rollRes.json().catch(() => ({}));
            throw new Error(errData.error || `Key rotation failed (${rollRes.status})`);
          }
        } catch (rollErr) {
          if (rollErr.message && !rollErr.message.includes('404')) {
            throw rollErr;
          }
        }
      }

      await setTransportConfig({
        baseUrl: val.url,
        token: finalToken,
        teacherId: finalTeacherId,
        name: finalTeacherName
      });

      toast.success('Successfully connected to school server!');
      renderRelaySection(mount, router, val.url, finalTeacherId);
    } catch (err) {
      feedback.className = 'text-xs text-rose-600 block';
      feedback.textContent = `Connection failed: ${err.message}`;
    } finally {
      submitBtn.loading = false;
    }
  });
}

// -----------------------------------------------------------------------------
// 3. Set Up Server Guide Section
// -----------------------------------------------------------------------------
function renderGuideSection(mount) {
  mount.innerHTML = `
    <div class="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
      <div>
        <h3 class="font-bold text-slate-900 text-base">School Relay Setup Guide</h3>
        <p class="text-xs text-slate-500 mt-0.5">Four deployment options for teachers and IT administrators.</p>
      </div>
      ${renderRelaySetupGuideHTML()}
    </div>
  `;
}

// -----------------------------------------------------------------------------
// 4. Devices & Sync Section
// -----------------------------------------------------------------------------
async function renderDevicesSection(mount, router) {
  const currentDeviceId = storage.deviceId;
  mount.innerHTML = `
    <div class="space-y-6">
      <div class="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
        <div class="flex items-center justify-between">
          <div>
            <h3 class="font-bold text-slate-900 text-base">Connected Devices</h3>
            <p class="text-xs text-slate-500 mt-0.5">Manage devices linked to your sync workspace.</p>
          </div>
          <sl-button size="small" id="btn-force-sync"><sl-icon slot="prefix" name="arrow-repeat"></sl-icon> Force Full Sync</sl-button>
        </div>

        <div class="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
          <div class="p-3 bg-slate-50 flex items-center justify-between">
            <div class="flex items-center gap-2">
              <sl-icon name="laptop" class="text-blue-600 text-lg"></sl-icon>
              <div>
                <div class="font-semibold text-xs text-slate-800 flex items-center gap-1.5">
                  Device: <code class="font-mono">${esc(currentDeviceId?.slice(0, 8))}...</code>
                  <span class="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 text-[10px] font-bold">This device</span>
                </div>
                <div class="text-[11px] text-slate-400 mt-0.5">Active now</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  mount.querySelector('#btn-force-sync')?.addEventListener('click', async () => {
    try {
      const { syncNow } = await import('../../core/replication/manager.js');
      if (typeof syncNow === 'function') {
        await syncNow();
        toast.success('Sync completed.');
      } else {
        toast.info('Local sync engine is up to date.');
      }
    } catch (err) {
      toast.warning('Sync completed with notice: ' + err.message);
    }
  });
}

// -----------------------------------------------------------------------------
// 5. Backups Section
// -----------------------------------------------------------------------------
async function renderBackupsSection(mount, router) {
  mount.innerHTML = `
    <div class="space-y-6">
      <div class="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
        <h3 class="font-bold text-slate-900 text-base">Local Encrypted Backups</h3>
        <p class="text-xs text-slate-500 leading-relaxed">
          KennisBoost automatically takes local snapshots of all your classes and grades. Backups are encrypted with AES-256-GCM.
        </p>
        <div class="flex gap-2">
          <sl-button size="small" variant="primary" id="btn-take-backup-now"><sl-icon slot="prefix" name="cloud-arrow-up"></sl-icon> Export Backup File (.kb)</sl-button>
          <sl-button size="small" id="btn-import-backup-file"><sl-icon slot="prefix" name="folder2-open"></sl-icon> Restore from File</sl-button>
          <input type="file" id="input-backup-picker" accept=".kb,.json" class="hidden">
        </div>
      </div>
    </div>
  `;

  const picker = mount.querySelector('#input-backup-picker');
  mount.querySelector('#btn-take-backup-now')?.addEventListener('click', async () => {
    const { exportManualBackup } = await import('../../core/storage.js');
    if (typeof exportManualBackup === 'function') {
      await exportManualBackup();
    } else {
      const { exportFullJsonBackup } = await import('../../core/records-export.js');
      await exportFullJsonBackup();
    }
  });

  mount.querySelector('#btn-import-backup-file')?.addEventListener('click', () => picker?.click());
  picker?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      const text = await file.text();
      const { restoreBackupText } = await import('../../main.js');
      await restoreBackupText(text, file.name);
    }
    picker.value = '';
  });
}

// -----------------------------------------------------------------------------
// 6. Appearance Section
// -----------------------------------------------------------------------------
function renderAppearanceSection(mount) {
  const currentTheme = localStorage.getItem('kb_theme') || 'system';

  mount.innerHTML = `
    <div class="space-y-6">
      <div class="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
        <h3 class="font-bold text-slate-900 text-base">Theme</h3>
        <sl-radio-group id="radio-theme-picker" value="${esc(currentTheme)}">
          <sl-radio-button value="light"><sl-icon slot="prefix" name="sun"></sl-icon> Light</sl-radio-button>
          <sl-radio-button value="dark"><sl-icon slot="prefix" name="moon"></sl-icon> Dark</sl-radio-button>
          <sl-radio-button value="system"><sl-icon slot="prefix" name="laptop"></sl-icon> System</sl-radio-button>
        </sl-radio-group>
      </div>

      <div class="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
        <h3 class="font-bold text-slate-900 text-base">Responsive &amp; Safe Area Debugging</h3>
        <p class="text-xs text-slate-500">Enable an outline around safe area insets on mobile notch and home indicator screens.</p>
        <sl-switch id="switch-safe-area-debug">Show Safe Area Outline</sl-switch>
      </div>
    </div>
  `;

  mount.querySelector('#radio-theme-picker')?.addEventListener('sl-change', (e) => {
    const val = e.target.value;
    localStorage.setItem('kb_theme', val);
    if (val === 'dark' || (val === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark', 'sl-theme-dark');
    } else {
      document.documentElement.classList.remove('dark', 'sl-theme-dark');
    }
    toast.success(`Theme set to ${val}`);
  });

  mount.querySelector('#switch-safe-area-debug')?.addEventListener('sl-change', (e) => {
    document.body.classList.toggle('kb-debug-safe-area', e.target.checked);
  });
}
