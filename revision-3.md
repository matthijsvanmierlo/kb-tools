# Revision 3 — Security Hardening, Durability, Classroom Workflow & PWA

Source: *KennisBoost Tools: Comprehensive Architecture, Security, and Workflow Recommendations*.
Baseline: commit `70000d1`, 17 test files / 186 tests passing.

## 0. Gap analysis (recommendation → current state)

| § | Recommendation | State before rev-3 | Action |
|---|---|---|---|
| 2.1 | Zero-external CSP | No CSP. All libs (Dexie, Zod, marked, DOMPurify, jsPDF, JSZip, Shoelace, KaTeX) load from jsDelivr; YouTube/Vimeo SDK scripts injected at runtime; 3 inline scripts + inline `onclick=` handlers | **Vendor everything**, replace SDK scripts with postMessage drivers, remove inline handlers, add CSP |
| 2.1 | DOMPurify profile | Profiles html+svg+mathMl with a short FORBID list | Explicit allowlist (markdown + KaTeX), URI allowlist, safe-link hook; fix unescaped `innerHTML` sinks found by audit |
| 2.2 | Hash scrubbing / no-referrer | Keys/payloads stay in the address bar and history | `history.replaceState` after parse; `<meta name="referrer" content="no-referrer">` |
| 2.3 | AES-GCM-256 / PBKDF2 ≥ 600k | AES-GCM-256 ✔, PBKDF2 **100k** | New `v2` share format at 600k; legacy links still open |
| 2.4 | HMAC tamper-proofing | ECIES to teacher key + access-code HMAC + teacher-side re-grade (already stronger than the proposal) | Keep design; add explicit tamper tests (see Decisions) |
| 3.1 | `storage.persist()` | Requested on first interaction ✔ | Also check `persisted()` at boot; surface status |
| 3.2 | Ephemeral/guest detection | Only detects IndexedDB open failure; quota warning built but never shown (bug) | Quota < 120 MB banner; fix quota warning |
| 3.3 | `CompressionStream('deflate-raw')` | LZ-String | Used in v2 share format with LZ fallback for decoding |
| 3.4 | File System Access auto-sync | Implemented, but: handle is written into backups (restores as `{}` → crash), changes during an in-flight write are dropped, no re-auth prompt at boot | Fix all three |
| 3.5 | Runtime schema validation on import | Zod used for CSV imports; **backup restore is unvalidated and unconfirmed** | Zod snapshot schema, confirmation dialog with counts, non-portable keys excluded |
| 4.1 | QR handshake | — | Animated multi-part QR carrying the full encrypted submission; teacher camera scanner (BarcodeDetector → jsQR fallback) |
| 4.2 | Multi-file dropzone | Implemented (inbox, `multiple`, zip) ✔ | Add zip-bomb limits |
| 4.3 | Canvas / Google Classroom CSV | Canvas ✔ | Add Google Classroom preset |
| 5.1 | OS file handlers | Manifest has only a data-URI icon | Real icon files, `file_handlers` for `.kbshare/.kbsub/.kbr`, `launchQueue` consumer |
| 5.2 | Web Share Target | — | POST share target handled entirely in the service worker |
| 6.1 | Image downsampling | Cards have no images | Card images → WebP ≤ 800 px @ 0.75, stored as `Blob` |
| 6.2 | Micro audio | — | MediaRecorder clips (Opus/WebM, ≤ 10 s) stored as `Blob` |
| 6.3 | FSRS retention slider + forecast | Retention fixed at 0.90 | Slider 0.80–0.95, reschedule, 7-day forecast |
| — | **Bug** | `sw.js` contains an ES `export` but is registered as a classic worker → `SyntaxError`, service worker never installs (no offline support) | Make `sw.js` a valid classic worker; test via `vm` |

## 1. Decisions & deliberate deviations

1. **`connect-src 'self'` instead of `'none'`.** Shoelace fetches its icon SVGs with `fetch()`; the
   optional school relay also needs network access. `'self'` still guarantees no third-party
   exfiltration. A relay on another origin must be added to `connect-src` by the deployer
   (`KB_RELAY_ORIGIN` for `server.js`; edit the meta tag for static hosting). The relay dialog
   detects CSP blocks and explains this.
2. **Video embeds.** `script-src 'self'` rules out the YouTube IFrame API and Vimeo SDK scripts. The
   drivers are rewritten to drive the embeds over `postMessage` (both players support this
   natively), so the only third-party allowance is `frame-src` for
   `youtube-nocookie.com` and `player.vimeo.com`. `media-src` keeps `https:` because teachers link
   their own MP4 files.
3. **Import map hash.** The inline import map stays (tests resolve bare specifiers from
   `node_modules`); its SHA-256 is pinned in the CSP and a test fails if they drift.
4. **`frame-ancestors`** is ignored in `<meta>` CSP, so it ships via HTTP headers (`server.js`,
   `_headers` for Cloudflare Pages / Netlify). GitHub Pages cannot set headers; documented.
5. **DOMPurify allowlist.** The proposal's 17-tag list would break KaTeX (MathML + SVG), links,
   images, block quotes and tables. We use an explicit allowlist sized for markdown + KaTeX and
   remove risky SVG elements (`foreignObject`, `use`, animation, `style`).
6. **No embedded `assignmentSecret`.** Shipping the HMAC secret inside the assignment lets any
   student re-sign a forged score. The existing design is kept: submissions are encrypted to the
   teacher's public key, signed with the student's personal access code, and **scores are always
   re-computed from answers on the teacher's device**. The QR channel therefore carries the full
   encrypted submission, not a score.
7. **PBKDF2 for submission identity HMACs stays at 100k.** It runs once per submission during bulk
   import (30+ derivations); the access code's entropy, not the iteration count, dominates.
   Share links/report passphrases move to 600k.
8. **`.kbshare` is the deck/lesson file type** (the proposal's `.kbdeck`); no new extension is added.
9. **Hash scrubbing vs reload.** After scrubbing, a reload no longer re-opens a shared lesson
   (assignments already survive via `sessionStorage`). The shared-content banner offers
   "Save to my library" so nothing is lost.

## 2. Phases

### Phase A — Self-hosted dependencies & service worker
- `scripts/vendor.mjs` (esbuild) bundles each import-map package into `vendor/<name>.mjs`; copies
  Shoelace `cdn/` and KaTeX dist (css, fonts, mhchem, auto-render) into `vendor/`. `npm run vendor`.
- `index.html`: import map → `./vendor/*.mjs`; Shoelace/KaTeX from `vendor/`.
- Zod `jitless` mode (avoids `new Function` CSP violation).
- `sw.js`: valid classic worker, helper functions exposed for tests; precache vendor core; drop CDN logic.
- Verify: tests green; app boots with network disabled after first load.

### Phase B — CSP, headers, inline-code removal, video drivers
- Move theme pre-paint + `file://` guard into `src/boot/preboot.js` (classic, sync).
- Remove all inline `on*=` handlers (router, main, project-library, `config.js` onerror).
- CSP meta + `referrer` meta; `server.js` sends CSP (with `frame-ancestors`), `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`, CORP/COOP; drop `Access-Control-Allow-Origin: *`;
  fix path traversal handling; `_headers` file for static hosts.
- postMessage YouTube/Vimeo drivers.
- Tests: CSP directives, import-map hash, no inline handlers, no external script URLs.

### Phase C — Sanitization & XSS sinks
- Hardened `Sanitizer` (allowlist, URI regexp, safe-link hook).
- Fix every unescaped cross-user sink reported by the audit.
- Tests: injection payload corpus through `renderSTEMMarkdown` / `sanitize`.

### Phase D — Share crypto v2 & URL hygiene
- `v2`: JSON → deflate-raw → (optional PBKDF2-600k/AES-GCM, `salt‖iv‖ct`) → base64url, `#/share?v=2&enc=…&d=…`.
  Fallback to v1 when `CompressionStream` is missing; v1 decoding retained.
- Scrub `d`, `k`, `ref` (and other payload params) from the address bar after parsing.
- Tests: round-trip, legacy compat, wrong passphrase, size reduction, tamper → reject.

### Phase E — Storage durability
- Ephemeral/guest quota banner (< 120 MB); quota warning fix; `persisted()` status.
- Auto-sync: pending-write flag, re-auth banner at boot, status indicator states.
- Backup: exclude non-portable metadata (`autosync_file_handle`, `device_id`), Zod-validated
  restore with a confirmation dialog listing record counts; include media blobs.
- Inbox zip limits (entries / uncompressed size).

### Phase F — Classroom workflow
- `src/core/qr-transfer.js`: framing (`KBQ1`), chunking, reassembly (pure, tested).
- Student results screen: "Show QR code" (animated parts, manual stepping).
- Teacher inbox: "Scan QR codes" (camera; BarcodeDetector, jsQR fallback), feeds existing import.
- Google Classroom CSV preset (Email, Score, Feedback).

### Phase G — PWA integration
- `icons/` SVG + PNG icons; manifest `id`, `file_handlers`, `share_target` (POST multipart).
- `launchQueue` consumer → inbox / share import; SW handles share-target POST and stashes files.

### Phase H — Rich media
- `src/utils/media.js`: canvas downscale to WebP, MediaRecorder clip capture.
- Flashcard editor: add image / record audio per side; study player renders/plays them.
- Blobs live in `binary_blobs`; backups and `.kbshare` files embed them as base64.

### Phase I — FSRS controls
- Retention slider (0.80–0.95, default 0.90) persisted in metadata; review cards rescheduled.
- 7-day workload forecast bar chart on the flashcards dashboard.

## 3. Verification checklist

| Area | Check | How |
|---|---|---|
| CSP | No violations, app usable offline | Load app in Chrome, DevTools console, offline mode |
| CSP | Import-map hash matches | `tests/phase18-security-headers.test.js` |
| Sanitizer | Injection corpus neutralised | `tests/phase19-sanitizer.test.js` |
| URL | Hash scrubbed after load | test + manual |
| Crypto | v2 round trip, legacy v1, tamper rejection, edited score re-graded | `tests/phase20-share-v2.test.js`, phase 8 tests |
| Storage | Ephemeral banner, safe restore | `tests/phase21-durability.test.js` |
| QR | Chunk/reassemble, out-of-order, duplicates | `tests/phase22-qr-transfer.test.js` |
| CSV | Google Classroom headers | `tests/phase16-gradebook-csv.test.js` |
| PWA | Manifest file handlers, SW parses | `tests/phase23-pwa.test.js` |
| FSRS | Interval grows as retention drops; forecast buckets | `tests/phase24-fsrs-retention.test.js` |

## 4. Implementation status (2026-10-18)

All phases A–I are implemented. 24 test files / 272 tests pass (`npm test`), up from 17 / 186.

Verified in headless Chromium 155 against `npm start`:
- Zero CSP violations, console errors or failed requests on every route (`#/`, flashcards,
  timeline, video, assignments, gradebook, inbox, about, guide).
- No horizontal overflow at 390 px on the main routes.
- Opening a v2 share link loads the lesson and leaves no payload in the address bar.
- YouTube (youtube-nocookie) and Vimeo embeds become ready, report duration and seek over
  postMessage with no third-party script on the page.
- A real encrypted submission → QR frames → rendered → decoded by the vendored jsQR → reassembled
  byte-for-byte.
- A 3000×2000 PNG becomes an 800×533 WebP of 18 KB.
- The service worker installs, intercepts share-target POSTs, and the app boots offline.

Additional defects found and fixed along the way:
- `sw.js` contained `export` → the service worker never installed (no offline mode at all).
- Shoelace's base path was derived as a bare specifier once self-hosted; components silently
  failed to load (guarded by `src/boot/shoelace-setup.js`).
- Auto-sync rescheduled itself forever (each write stored a timestamp that counted as a change),
  dropped edits made during an in-flight write, and crashed after restoring a backup that contained
  a serialized file handle.
- Home → "Open shared file" called a non-existent `ShareModal.openImportDialog`, and opening a
  `.kbsub` there navigated to the inbox without the file.
- `access-codes.js` printing helper lost `this` and threw; `Sanitizer.escapeHtml` blanked numbers.
- Dozens of unescaped interpolations of shared/imported data across ~25 view files, including four cross-user paths (student→teacher via inbox headers and .kbr receipts; crafted #/feedback and #/report links).

Not done / follow-ups:
- Backups and the auto-sync file are plaintext JSON that include the teacher's private submission
  key and student access codes. An optional passphrase-encrypted backup would be a good next step.
- The submission-identity HMAC keeps PBKDF2 at 100k iterations (see §1.7).
- Media blobs of deleted cards are not garbage-collected yet.
- `npm audit` reports a high-severity advisory in Tailwind 3's build-time dependency chain
  (braces/micromatch); it never ships to browsers, and fixing it means migrating to Tailwind 4.
- `vendor/` (~14 MB, mostly Shoelace icons) is committed so the site deploys without a build step.

### Maintenance commands

| Command | When |
|---|---|
| `npm run vendor` | after upgrading any front-end dependency |
| `npm run csp` | after editing the import map (`KB_RELAY_ORIGIN=… npm run csp` to allow a relay) |
| `npm run build` | before deploying: Tailwind CSS, CSP, service-worker precache list + version |
