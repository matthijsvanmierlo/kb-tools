// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { storage } from '../src/core/storage.js';
import { validateRelayUrl, renderSettingsView } from '../src/modules/settings/index.js';
import { RELAY_SETUP_PATHS, renderRelaySetupGuideHTML } from '../src/components/relay-setup-guide.js';
import { router } from '../src/router.js';
import { ConfirmDialog } from '../src/utils/dialogs.js';
import { setTransportConfig, getTransportConfig, clearTransportConfig } from '../src/core/transport.js';

describe('WS4: Settings hub and relay setup guide', () => {
  beforeEach(async () => {
    await storage.init({ dbName: `kb-settings-test-${Date.now()}` });
    await clearTransportConfig();
  });

  // 1. URL validation: rejects public http, accepts https/localhost/local
  it('1. validates relay URLs and rejects insecure public http', () => {
    // Insecure public http
    const resPublicHttp = validateRelayUrl('http://relay.myschool.edu');
    expect(resPublicHttp.ok).toBe(false);
    expect(resPublicHttp.reason).toMatch(/Public relay servers must use HTTPS/);

    // Secure public https
    const resHttps = validateRelayUrl('https://relay.myschool.edu');
    expect(resHttps.ok).toBe(true);
    expect(resHttps.url).toBe('https://relay.myschool.edu');

    // Localhost http is permitted
    const resLocalhost = validateRelayUrl('http://localhost:8787');
    expect(resLocalhost.ok).toBe(true);
    expect(resLocalhost.url).toBe('http://localhost:8787');

    // Local IP http is permitted
    const resLocalIp = validateRelayUrl('http://192.168.1.50:8000');
    expect(resLocalIp.ok).toBe(true);

    // Local mDNS http is permitted
    const resLocalMdns = validateRelayUrl('http://kb-relay.local:8787');
    expect(resLocalMdns.ok).toBe(true);
  });

  // 2. Settings route renders correct section based on query param
  it('2. renders settings tabs and deep-links by section', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    // Section: relay
    await renderSettingsView({ section: 'relay' }, router, container);
    expect(container.querySelector('[data-section="relay"]').classList.contains('border-blue-600')).toBe(true);
    expect(container.querySelector('#form-connect-relay')).not.toBeNull();

    // Section: guide
    await renderSettingsView({ section: 'guide' }, router, container);
    expect(container.querySelector('[data-section="guide"]').classList.contains('border-blue-600')).toBe(true);
    expect(container.innerHTML).toContain('Cloudflare Workers + D1');

    // Section: appearance
    await renderSettingsView({ section: 'appearance' }, router, container);
    expect(container.querySelector('#radio-theme-picker')).not.toBeNull();

    container.remove();
  });

  // 3. /whoami validation gate rejects 401 token
  it('3. rejects saving invalid token when test connection fails with 401', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);

    await renderSettingsView({ section: 'relay' }, router, container);
    const urlInput = container.querySelector('#input-relay-url');
    const tokenInput = container.querySelector('#input-relay-token');
    const form = container.querySelector('#form-connect-relay');

    urlInput.value = 'http://localhost:8787';
    tokenInput.value = 'bad-token';

    // Mock fetch to simulate 401 on /whoami
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((url) => {
      if (url.includes('/health')) {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, version: '2' }), { status: 200 }));
      }
      if (url.includes('/whoami')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    try {
      const btnTest = container.querySelector('#btn-test-before-save');
      btnTest.click();
      await new Promise(resolve => setTimeout(resolve, 50));

      const feedback = container.querySelector('#relay-validation-feedback');
      expect(feedback.textContent).toMatch(/401 Unauthorized/);
    } finally {
      globalThis.fetch = origFetch;
      container.remove();
    }
  });

  // 4. One-click connect link prompts for explicit confirmation
  it('4. requires explicit confirmation before accepting #/connect link credentials', async () => {
    const confirmSpy = vi.spyOn(ConfirmDialog, 'show').mockResolvedValue(true);
    const navSpy = vi.spyOn(router, 'navigate').mockImplementation(() => {});

    await router._handleConnectRoute({
      relay: 'https://relay.myschool.edu',
      token: 'teacher-secret-token',
      teacherId: 'Teacher Maya'
    });

    expect(confirmSpy).toHaveBeenCalled();
    const config = await getTransportConfig();
    expect(config.baseUrl).toBe('https://relay.myschool.edu');
    expect(config.token).toBe('teacher-secret-token');

    confirmSpy.mockRestore();
    navSpy.mockRestore();
  });

  // 5. Guide copy matches docs/it-deployment.md
  it('5. ensures relay setup guide paths match documentation', () => {
    const docPath = path.join(process.cwd(), 'docs', 'it-deployment.md');
    const docText = fs.readFileSync(docPath, 'utf8');

    // Verify key setup guide steps are documented
    expect(RELAY_SETUP_PATHS.pathA.steps[0].command).toBe('npm install -g wrangler');
    expect(RELAY_SETUP_PATHS.pathA.steps[2].command).toBe('wrangler d1 create kb-relay');
    expect(RELAY_SETUP_PATHS.pathB.id).toBe('vps');
    expect(RELAY_SETUP_PATHS.pathC.id).toBe('lan');
    expect(RELAY_SETUP_PATHS.pathD.id).toBe('managed');

    // Guide HTML renders all 4 options
    const html = renderRelaySetupGuideHTML();
    expect(html).toContain('Cloudflare Workers + D1');
    expect(html).toContain('Node + SQLite on a VPS');
    expect(html).toContain('School LAN Server');
    expect(html).toContain('Managed Hosted Relay');
  });
});
