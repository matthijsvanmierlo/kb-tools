import { Sanitizer } from '../core/sanitizer.js';

export const RELAY_SETUP_PATHS = {
  pathA: {
    id: 'cloudflare',
    title: 'Cloudflare Workers + D1 (Free, Serverless, Recommended)',
    cost: '$0.00 / month (Free tier)',
    badge: 'Recommended',
    steps: [
      { step: 1, title: 'Install Wrangler', command: 'npm install -g wrangler' },
      { step: 2, title: 'Login to Cloudflare', command: 'wrangler login' },
      { step: 3, title: 'Create D1 database', command: 'wrangler d1 create kb-relay' },
      {
        step: 4,
        title: 'Configure wrangler.toml',
        configBlock: `name = "kb-relay"
main = "server/relay/worker.js"
compatibility_date = "2024-04-01"

[[d1_databases]]
binding = "DB"
database_name = "kb-relay"
database_id = "<YOUR_D1_DATABASE_ID>"`
      },
      { step: 5, title: 'Deploy worker to Cloudflare Edge', command: 'wrangler deploy' },
      { step: 6, title: 'Generate teacher tokens', command: 'npm run relay:seed-teachers' },
      { step: 7, title: 'Connect to app', description: 'Paste the generated connect_url or token into the app settings.' }
    ]
  },
  pathB: {
    id: 'vps',
    title: 'Node + SQLite on a VPS (Docker / systemd)',
    cost: 'Self-hosted VM',
    steps: [
      {
        step: 1,
        title: 'docker-compose.yml with automatic HTTPS via Caddy',
        configBlock: `version: '3.8'
services:
  relay:
    image: node:20-alpine
    working_dir: /app
    volumes:
      - .:/app
      - relay_data:/app/data
    environment:
      - NODE_ENV=production
      - KB_RELAY_DB=/app/data/relay.db
      - PORT=8000
    command: npm run relay
    restart: unless-stopped
  caddy:
    image: caddy:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
      - caddy_config:/config
    restart: unless-stopped
volumes:
  relay_data:
  caddy_data:
  caddy_config:`
      },
      {
        step: 2,
        title: 'One-line deployment command',
        command: 'curl -sSL https://raw.githubusercontent.com/kennisboost/kb-tools/main/scripts/deploy.sh | bash'
      }
    ]
  },
  pathC: {
    id: 'lan',
    title: 'School LAN Server (Raspberry Pi / Classroom PC)',
    cost: 'Local Subnet / mDNS',
    steps: [
      { step: 1, title: 'Start LAN relay on local network', command: 'PORT=8787 npm run relay' },
      { step: 2, title: 'Connect via local mDNS address', description: 'Point devices to http://kb-relay.local:8787 on your classroom Wi-Fi.' },
      { step: 3, title: 'Trust self-signed certificates on iOS/Chromebooks', description: 'If running over local TLS, install and trust the generated root CA certificate in device Settings.' }
    ]
  },
  pathD: {
    id: 'managed',
    title: 'Managed Hosted Relay (KennisBoost Cloud)',
    cost: 'Zero-config turnkey',
    status: 'Coming soon',
    description: 'Fully managed, zero-knowledge relay hosted on compliant EU/US infrastructure. Enter your email to be notified when available.'
  }
};

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));

export function renderRelaySetupGuideHTML() {
  const a = RELAY_SETUP_PATHS.pathA;
  const b = RELAY_SETUP_PATHS.pathB;
  const c = RELAY_SETUP_PATHS.pathC;
  const d = RELAY_SETUP_PATHS.pathD;

  return `
    <div class="space-y-4 text-xs text-slate-600 leading-relaxed max-h-[70vh] overflow-y-auto pr-1">
      <div class="p-3 bg-blue-50 border border-blue-200 rounded-xl text-blue-900">
        <h4 class="font-bold text-sm mb-1 flex items-center gap-1.5">
          <sl-icon name="info-circle" class="text-blue-600"></sl-icon> School Sync & Relay Architecture
        </h4>
        <p class="text-xs">
          KennisBoost is 100% local-first and zero-knowledge. The relay server is a blind ciphertext broker: all lessons, submissions, drafts, and grade reports are end-to-end encrypted before leaving devices.
        </p>
      </div>

      <div class="space-y-3">
        <!-- Path A: Cloudflare Workers + D1 -->
        <details class="group border border-slate-200 rounded-xl overflow-hidden bg-white" open>
          <summary class="flex items-center justify-between p-3 font-semibold text-slate-800 cursor-pointer bg-slate-50 hover:bg-slate-100 transition-colors">
            <span class="flex items-center gap-2">
              <span class="w-6 h-6 rounded-full bg-amber-100 text-amber-700 font-bold flex items-center justify-center text-xs">A</span>
              ${esc(a.title)} — <em class="text-emerald-600 font-semibold">${esc(a.cost)}</em>
            </span>
            <sl-icon name="chevron-down" class="group-open:rotate-180 transition-transform"></sl-icon>
          </summary>
          <div class="p-3 space-y-3 border-t border-slate-100 bg-white">
            <p>Deploy on Cloudflare's serverless edge with zero maintenance and no server to patch:</p>
            <div class="space-y-2">
              ${a.steps.map(s => `
                <div class="space-y-1">
                  <div class="font-semibold text-slate-700 flex items-center gap-1.5">
                    <span class="w-4 h-4 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center text-[10px] font-bold">${s.step}</span>
                    ${esc(s.title)}
                  </div>
                  ${s.command ? `
                    <div class="relative group/code">
                      <pre class="bg-slate-900 text-slate-100 p-2.5 rounded-lg font-mono text-[11px] overflow-x-auto"><code>${esc(s.command)}</code></pre>
                    </div>
                  ` : ''}
                  ${s.configBlock ? `
                    <pre class="bg-slate-900 text-slate-100 p-2.5 rounded-lg font-mono text-[11px] overflow-x-auto"><code>${esc(s.configBlock)}</code></pre>
                  ` : ''}
                  ${s.description ? `<p class="text-[11px] text-slate-500 pl-5">${esc(s.description)}</p>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        </details>

        <!-- Path B: Node + SQLite on VPS -->
        <details class="group border border-slate-200 rounded-xl overflow-hidden bg-white">
          <summary class="flex items-center justify-between p-3 font-semibold text-slate-800 cursor-pointer bg-slate-50 hover:bg-slate-100 transition-colors">
            <span class="flex items-center gap-2">
              <span class="w-6 h-6 rounded-full bg-blue-100 text-blue-700 font-bold flex items-center justify-center text-xs">B</span>
              ${esc(b.title)}
            </span>
            <sl-icon name="chevron-down" class="group-open:rotate-180 transition-transform"></sl-icon>
          </summary>
          <div class="p-3 space-y-3 border-t border-slate-100 bg-white">
            <p>Run on a VPS or cloud server with Docker and automatic TLS via Caddy:</p>
            <div class="space-y-2">
              ${b.steps.map(s => `
                <div class="space-y-1">
                  <div class="font-semibold text-slate-700 flex items-center gap-1.5">
                    <span class="w-4 h-4 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center text-[10px] font-bold">${s.step}</span>
                    ${esc(s.title)}
                  </div>
                  ${s.configBlock ? `<pre class="bg-slate-900 text-slate-100 p-2.5 rounded-lg font-mono text-[11px] overflow-x-auto"><code>${esc(s.configBlock)}</code></pre>` : ''}
                  ${s.command ? `<pre class="bg-slate-900 text-slate-100 p-2.5 rounded-lg font-mono text-[11px] overflow-x-auto"><code>${esc(s.command)}</code></pre>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        </details>

        <!-- Path C: School LAN Server -->
        <details class="group border border-slate-200 rounded-xl overflow-hidden bg-white">
          <summary class="flex items-center justify-between p-3 font-semibold text-slate-800 cursor-pointer bg-slate-50 hover:bg-slate-100 transition-colors">
            <span class="flex items-center gap-2">
              <span class="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 font-bold flex items-center justify-center text-xs">C</span>
              ${esc(c.title)}
            </span>
            <sl-icon name="chevron-down" class="group-open:rotate-180 transition-transform"></sl-icon>
          </summary>
          <div class="p-3 space-y-2 border-t border-slate-100 bg-white">
            <div class="space-y-2">
              ${c.steps.map(s => `
                <div class="space-y-1">
                  <div class="font-semibold text-slate-700 flex items-center gap-1.5">
                    <span class="w-4 h-4 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center text-[10px] font-bold">${s.step}</span>
                    ${esc(s.title)}
                  </div>
                  ${s.command ? `<pre class="bg-slate-900 text-slate-100 p-2.5 rounded-lg font-mono text-[11px] overflow-x-auto"><code>${esc(s.command)}</code></pre>` : ''}
                  ${s.description ? `<p class="text-[11px] text-slate-500 pl-5">${esc(s.description)}</p>` : ''}
                </div>
              `).join('')}
            </div>
          </div>
        </details>

        <!-- Path D: Managed Hosted Relay -->
        <details class="group border border-slate-200 rounded-xl overflow-hidden bg-white">
          <summary class="flex items-center justify-between p-3 font-semibold text-slate-800 cursor-pointer bg-slate-50 hover:bg-slate-100 transition-colors">
            <span class="flex items-center gap-2">
              <span class="w-6 h-6 rounded-full bg-purple-100 text-purple-700 font-bold flex items-center justify-center text-xs">D</span>
              ${esc(d.title)} — <em class="text-purple-600 font-semibold">${esc(d.status)}</em>
            </span>
            <sl-icon name="chevron-down" class="group-open:rotate-180 transition-transform"></sl-icon>
          </summary>
          <div class="p-3 space-y-3 border-t border-slate-100 bg-white">
            <p>${esc(d.description)}</p>
            <div class="flex gap-2 max-w-sm">
              <sl-input placeholder="school-it@district.edu" size="small" class="flex-1" type="email"></sl-input>
              <sl-button size="small" variant="primary">Notify Me</sl-button>
            </div>
          </div>
        </details>
      </div>
    </div>
  `;
}
