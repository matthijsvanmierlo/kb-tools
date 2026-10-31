import { Sanitizer } from '../core/sanitizer.js';

export function renderRelaySetupGuideHTML() {
  return `
    <div class="space-y-4 text-xs text-slate-600 leading-relaxed max-h-[60vh] overflow-y-auto pr-1">
      <div class="p-3 bg-blue-50 border border-blue-200 rounded-xl text-blue-900">
        <h4 class="font-bold text-sm mb-1 flex items-center gap-1.5">
          <sl-icon name="info-circle" class="text-blue-600"></sl-icon> School Sync & Relay Architecture
        </h4>
        <p class="text-xs">
          KennisBoost is 100% local-first and zero-knowledge. The relay server is a blind ciphertext broker: all lessons, submissions, drafts, and grade reports are end-to-end encrypted before leaving devices.
        </p>
      </div>

      <div class="space-y-3">
        <!-- Option 1: Cloudflare Free Tier -->
        <details class="group border border-slate-200 rounded-xl overflow-hidden bg-white" open>
          <summary class="flex items-center justify-between p-3 font-semibold text-slate-800 cursor-pointer bg-slate-50 hover:bg-slate-100 transition-colors">
            <span class="flex items-center gap-2">
              <span class="w-6 h-6 rounded-full bg-amber-100 text-amber-700 font-bold flex items-center justify-center text-xs">1</span>
              Cloudflare Edge (Workers + D1 + R2) — <em>$0.00 / month Free Tier</em>
            </span>
            <sl-icon name="chevron-down" class="group-open:rotate-180 transition-transform"></sl-icon>
          </summary>
          <div class="p-3 space-y-2 border-t border-slate-100 bg-white">
            <p>Deploy on Cloudflare's serverless edge with 0 maintenance and no server to patch:</p>
            <div class="bg-slate-900 text-slate-100 p-2.5 rounded-lg font-mono text-[11px] overflow-x-auto space-y-1">
              <div># 1. Log in to your free Cloudflare account</div>
              <div>npx wrangler login</div>
              <div># 2. Create the serverless SQLite database</div>
              <div>npx wrangler d1 create kb-relay-db</div>
              <div># 3. Apply canonical database schema</div>
              <div>npm run relay:cf:schema</div>
              <div># 4. Deploy worker to global edge</div>
              <div>npm run relay:cf:deploy</div>
              <div># 5. Generate teacher bearer token</div>
              <div>npm run relay:add-teacher -- --name "Teacher Name" --url https://your-relay.workers.dev</div>
            </div>
            <p class="text-[11px] text-slate-500">
              Free tier includes: 100k requests/day, 5 GB D1 database, and 10 GB R2 media storage with zero bandwidth fees.
            </p>
          </div>
        </details>

        <!-- Option 2: Local Classroom / LAN -->
        <details class="group border border-slate-200 rounded-xl overflow-hidden bg-white">
          <summary class="flex items-center justify-between p-3 font-semibold text-slate-800 cursor-pointer bg-slate-50 hover:bg-slate-100 transition-colors">
            <span class="flex items-center gap-2">
              <span class="w-6 h-6 rounded-full bg-emerald-100 text-emerald-700 font-bold flex items-center justify-center text-xs">2</span>
              Local Classroom Server (Node.js + SQLite / Raspberry Pi)
            </span>
            <sl-icon name="chevron-down" class="group-open:rotate-180 transition-transform"></sl-icon>
          </summary>
          <div class="p-3 space-y-2 border-t border-slate-100 bg-white">
            <p>Run on a teacher laptop, Raspberry Pi, or school local machine:</p>
            <div class="bg-slate-900 text-slate-100 p-2.5 rounded-lg font-mono text-[11px] overflow-x-auto space-y-1">
              <div># 1. Initialize local SQLite database</div>
              <div>npm run relay:init</div>
              <div># 2. Generate initial teacher access token</div>
              <div>npm run relay:add-teacher -- --name "Primary Teacher"</div>
              <div># 3. Start local relay service on port 8000</div>
              <div>PORT=8000 npm run relay</div>
            </div>
            <p class="text-[11px] text-slate-500">
              Tip: For remote HTTPS access without firewall port forwarding, run <code>cloudflared tunnel run kb-relay</code>.
            </p>
          </div>
        </details>

        <!-- Option 3: School IT Managed Deployment -->
        <details class="group border border-slate-200 rounded-xl overflow-hidden bg-white">
          <summary class="flex items-center justify-between p-3 font-semibold text-slate-800 cursor-pointer bg-slate-50 hover:bg-slate-100 transition-colors">
            <span class="flex items-center gap-2">
              <span class="w-6 h-6 rounded-full bg-purple-100 text-purple-700 font-bold flex items-center justify-center text-xs">3</span>
              School IT Managed Config & Automatic Teacher Provisioning
            </span>
            <sl-icon name="chevron-down" class="group-open:rotate-180 transition-transform"></sl-icon>
          </summary>
          <div class="p-3 space-y-2 border-t border-slate-100 bg-white">
            <p>Pre-configure school devices by placing <code>config.json</code> in the app root:</p>
            <div class="bg-slate-900 text-slate-100 p-2.5 rounded-lg font-mono text-[11px] overflow-x-auto space-y-1">
              <div>{</div>
              <div>&nbsp;&nbsp;"relay": {</div>
              <div>&nbsp;&nbsp;&nbsp;&nbsp;"baseUrl": "https://relay.myschool.edu",</div>
              <div>&nbsp;&nbsp;&nbsp;&nbsp;"requireToken": true</div>
              <div>&nbsp;&nbsp;}</div>
              <div>}</div>
            </div>
            <p class="text-[11px] text-slate-500">
              Teachers can be onboarded in 1 click using the private token link: <code>https://app.school.edu/#/connect?relay=...&token=...</code>
            </p>
          </div>
        </details>
      </div>
    </div>
  `;
}
