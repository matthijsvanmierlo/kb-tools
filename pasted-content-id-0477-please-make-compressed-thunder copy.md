# Plan: Rebrand to "Assessments" + New Non-Autograded "Assignments" Feature

## Context

The app (kb-tools, "KennisBoost") currently has one assignment module: autograded interactive questions. The goal is to make the LMS flexible across disciplines by adding a simple **Assignment** feature with no autograding: rich-text description (with KaTeX/mhchem math & chemistry like the rest of the platform), student submissions as written response / in-app code with syntax highlighting / code file uploads / generic file uploads (CDN-gated) / drawings on a modern canvas, due dates, points-or-rubric-or-standards grading inline with the existing gradebook, and a teacher review platform with inline code comments, drawing annotations, feedback, and gradebook sync. The existing autograded module is rebranded **Assessments**.

**Architecture reality that shapes everything:** this is a 100% client-side, offline-first PWA — vanilla JS ES modules (no bundler; import map in `index.html`), Shoelace + Tailwind, Dexie 4/IndexedDB, hash router, no auth (teacher/student is a UI mode; security is cryptographic: ECIES submissions encrypted to the teacher's keypair, student identity via roster access-code HMAC, optional zero-knowledge relay server). Relay submission POST limit: 256KB; draft roaming limit: 64KB — binaries must go to the relay's CDN media store or embed in downloadable `.kbsub.html` files.

## Decisions (confirmed with user)

1. **New module owns `#/assignments`** (nav: "Assignments"); old module moves to `#/assessments/*` (nav: "Assessments") with legacy redirects. Verified safe: `_activateSharedPayload` (src/router.js:488) routes by envelope `type`, never URL, so all issued links/QRs/.kbshare files keep working.
2. **CodeMirror 6**, vendored as a single bundle, for student code writing and teacher read-only review with comment gutter.
3. **Resubmission after feedback is allowed** (revision loop); resubmissions badged "resubmitted after feedback".
4. Internal kind for the new module: **`task`** (tables `tasks`, `task_submissions`; payload kind `kb-task`; share types `task`, `task_feedback`; column `source.type: 'task'`). UI label is "Assignment" — display names are config (`ProjectLibraryView` takes `title`/`itemTypeName`). `assignment` identifiers are burned into wire formats and stay with the old module. **Persisted identifiers never change** in the rebrand (table names, `kind: 'kb-assignment'`, `SHARE_TYPES`, `assignment_id`, KBSUB headers, relay `drops.assignment_id`).
5. Drawings stored as **vector elements** (strokes + shapes + text), not PNG — enables teacher annotation overlay, crisp zoom, better compression. PNG only as size fallback / PDF export.
6. Student file uploads: **drop-secret-authorized presign + HMAC-signed expiring upload URLs + mandatory client-side AES-GCM encryption** (`kb-cdn+aes://` refs; keys travel only inside the teacher-encrypted envelope). Fixes the existing unauthenticated `PUT /media/upload` hole in the same stroke.

## Phase ordering

Phases 1–3 are independent of each other (1 must precede 4 because it frees `#/assignments`; 3 must precede 5–7 where its components are consumed). Each phase ends with `npm test` green and, when `index.html`/`vendor/` changed, `npm run vendor && npm run csp && npm run build:sw` committed together (CSP pins the import-map hash; sw-manifest regenerates the offline precache).

---

## Phase 1 — Rebrand: Assessments routes + strings

### 1a. Routes
- `src/router.js`: generalize the one-off redirect at line 131 into a `LEGACY_REDIRECTS` map consulted in `handleRoute` (absorb the gradebook roster case), **preserving query strings** (`?preview=1` etc. — the minimal-chrome check depends on it). Redirects: `#/assignments/take|submissions|edit` → `#/assessments/take|submissions|edit`. Comment next to the map: new module must use disjoint sub-paths (`create`/`work`/`review`) so these redirects stay unconditional.
- Add `#/assessments/*` to `ROUTE_TITLES` (line 25) and `_announceRouteChange` (line 619). Update minimal-chrome check (line 157), internal navigations at lines 549 (`→ #/assessments/take`) and 598 (`→ #/assessments/edit?id=`).
- `src/main.js:131-159`: register four `#/assessments/*` routes (same `loadAssignmentsModule`); check drag-drop hash checks at 165/173.
- `src/modules/assignments/index.js:20-57`: update `hash.startsWith('#/assignments/...')` dispatch + fallback navigates.
- Sweep all 58 `#/assignments` references across 18 files (app-nav.js:27, command-palette.js:115-138, home/index.js, home-stats.js:98, calendar/index.js, course/render.js, student/course-detail.js, inbox/index.js, about/index.js, guide/index.js, assignments/editor.js|take.js|submissions.js, gradebook/assignment-dialog.js, core/html-launcher.js:95-97,291-292, class-setup-wizard.js). Safe because outgoing share URLs are all `#/share?d=`.
- **Do NOT rename** `src/modules/assignments/` directory or internal identifiers/table names. Add a top-of-file comment: "Branded 'Assessments' in the UI; internal identifiers keep the historical name for data compatibility."

### 1b. Visible strings
"Assignment(s)" → "Assessment(s)" in: nav label, command palette, home cards (`home/index.js:60,149,219`, `home-stats.js:98`), calendar labels (`calendar/index.js:21-51`, `model.js:59-74`), course add-item dialog (`course/render.js:153-164,361-420`), `course-feed.js:24-44`, `student/course-detail.js:115-163`, inbox copy, html-launcher ("Assessment Package"), universal-import-dialog, content-importer display names, csv-templates (**labels/filenames only — keep CSV column keys the import parser matches**), guide/index.js (38 sites), about/index.js, handin-instructions.js, demo.js, export-presets.js, records-export.js, feedback-pdf.js headings, and `gradebook/assignment-dialog.js:67` "Interactive Assignment" → "Interactive Assessment". **Leave gradebook's generic "assignment = column" wording alone** (gradebook/index.js, virtual-grid.js, gradebook-csv.js, project-library.js "Class Assignment").
- QA gate: `grep -rn 'Assignment' src --include='*.js'` — classify every remaining hit as identifier/persisted (OK) vs visible (missed).

### 1c. Tests
Update route-asserting tests: `tests/course-revision-and-routes.test.js:138,147`, `phase22-qr-transfer.test.js:119`, `phase35-file-launch-philosophy-assignment-csv.test.js:43`. Add `tests/assessments-route-redirects.test.js`: each legacy path redirects preserving params; `_activateSharedPayload({type:'assignment'})` lands on `#/assessments/take`.

---

## Phase 2 — Task module core: schema, crypto pipeline, registration (no UI)

### 2a. Dexie v7 + registration (miss any of these and sync/backup silently breaks)
New `db.version(7)` block in `src/core/storage.js` (current schema v1–6 at lines 246-375):
- `tasks: 'id, title, class_id, updated_at'`
- `task_submissions: 'id, task_id, student_id, submitted_at, synced_at, updated_at, [task_id+student_id]'`

Register both in: `DATA_TABLES` (storage.js:7), `scopeOf()` (storage.js:31 — `tasks → class_id` scope; `task_submissions` reuse the submission scope pattern), ephemeral tables list (storage.js:378), `BACKUP_TABLES` (src/core/backup.js:15), `SYNC_TABLES` + conflict tables (src/core/replication/engine.js:19-21, 271), storage-info lists (src/main.js:359-360, 421-423).

### 2b. Record shapes
`tasks` record (`createBlankTask()` in new `src/modules/tasks/index.js`, mirroring `createBlankAssignment` at src/modules/assignments/index.js:59):
```
{ id, version, title, description /* STEM markdown */, class_id,
  gradebook: { course_id, category_id, column_id, gradebook_assignment_id },
  grading: { scoring: 'points'|'proficiency', max_points, rubric_id, standard_ids[] },  // mirrors gradebook column 1:1
  submission_types: {
    text: {enabled}, code: {enabled, languages[], default_language, filename_hint},
    code_files: {enabled, accept[], max_files}, files: {enabled, accept[], max_files, max_mb},  // CDN-gated
    drawing: {enabled} },
  settings: { due_date, due_time, require_access_code, allow_resubmit (default true), release_feedback_immediately },
  publish: null | { version, salt, published_at, fingerprint, roster_hash, relay, cdn_student_upload } }
```
`task_submissions`: identity/lateness fields mirroring `assignment_submissions` (built like `evaluateSubmission`, src/modules/assignments/pipeline.js:176) plus:
```
content: { text_md, code: [{id, filename, language, body, origin:'editor'|'upload'}],
           attachments: [{id, name, mime, size, sha256, ref /* kb-cdn+aes:// or data: */}],
           drawing: DrawDoc | null },
review: { points, status, rubric_eval{}, rubric_comments{}, standard_scores{}, standard_comments{},
          feedback, code_comments: { [codeFileId]: [{id, line, end_line, text, created_at}] },
          drawing_annotations: DrawDoc | null, reviewed_at },
returned_at, is_latest
```
**Inline code comments** anchor to `(codeFileId, 1-based line)` of the immutable submitted snapshot — no anchor drift; same structure travels in the feedback envelope.

### 2c. Zod + envelope routing
- `src/core/validator.js`: `TaskSchema`, `TaskSubmissionContentSchema`, `CodeCommentSchema`, `DrawElementSchema`/`DrawDocSchema` (see Phase 3b). **Also refresh stale gradebook schemas** (add `scoring`, `standard_ids`, `source`, `rubric_id` to GradebookAssignmentSchema:216; `standard_scores`, `standard_comments`, `rubric_comments`, `feedback_link`, `source_submission_id` to GradebookGradeSchema:230).
- `src/core/shared-payload.js:12`: add `'task'`, `'task_feedback'` to SHARE_TYPES; NUMERIC_KEYS additions (`max_points`, `line`, `end_line`, `max_files`, `max_mb`, `size`, `w`, `h`).
- `src/core/envelope-router.js` `classifyText` (~38-95): recognize KBSUB header `{kind:'task', task_id}`, JSON `kind:'task_feedback'`, html-wrapped `kind:'kb-task'`.

### 2d. Pipeline (new `src/modules/tasks/pipeline.js`, cloned from assignments/pipeline.js)
- `createTaskSubmission(...)` — clone of pipeline.js:119 with `content` instead of `answers`; same access-code HMAC + ECIES encrypt-to-teacher; header `{kind:'task', task_id, publish_version}`.
- `evaluateTaskSubmission(...)` — clone of pipeline.js:176: decrypt → task_id guards → `StudentMatcher` → **no autograde**, blank `review`; import `daysLate` from assignments/pipeline.js:157 (don't copy).
- `checkTaskAccessCode` — generalize `checkAccessCode` (pipeline.js:107) to HMAC over `task_id` (deliberately separate domain).
- `buildStudentTaskPayload` in `src/modules/tasks/publish-core.js` (modeled on `buildStudentPayload`, grading.js:453): kind `kb-task`, description, submission_types (files forced off unless `cdn_student_upload`), due, scoring/max_points, **rubric_preview** (stripped copy of the `gradebook_rubrics` record) and **standards_preview**, teacher_key, roster_checks/cards, relay `{base_url, drop_id, drop_secret, media}`. **Whitelist fields — never spread the teacher record** (the course-feed answer-key leak at core/course-feed.js:36-37 is the anti-pattern; do not copy it).
- `estimateEnvelopeSize` helper (JSON length × ~1.37 for base64url+ECIES overhead).

### 2e. GradebookBridge extension + bug fix in passing
- `src/modules/gradebook/bridge.js`: `upsertLinkedColumn` (line 26) accepts optional `scoring`, `rubricId` (persist to the column); `syncContentClassLink` (94) gains a `task` branch (maxPoints from `grading.max_points`, pass scoring/rubric/standards/category, `sourceType:'task'`); stale-column cleanup includes `'task'`.
- **Fix** `src/modules/assignments/submissions.js:787`: local `feedbackSummary(sub)` shadows the imported two-arg `feedbackSummary(assignment, sub)` (grading.js:264) but is called as `(a, sub)` — gradebook-synced feedback text currently loses teacher comments. Delete the local function.

### 2f. Tests — `tests/phase38-tasks-core.test.js`
v6→v7 migration keeps data; create→payload→submit→evaluate round trip incl. identity + days_late; classifyText routing; backup round trip includes new tables; refreshed gradebook schemas accept full shapes; payload contains no teacher-private material.

---

## Phase 3 — Infrastructure: CodeMirror 6, DrawBoard, student CDN uploads

### 3a. CodeMirror 6 (single vendored bundle)
- `npm i -D codemirror @codemirror/lang-python @codemirror/lang-javascript @codemirror/lang-java @codemirror/lang-cpp @codemirror/lang-html @codemirror/lang-css @codemirror/lang-sql @codemirror/theme-one-dark`.
- `scripts/vendor.mjs`: extend `ESM_PACKAGES` (lines 24-35) so an entry may be `{file, shim}`; the codemirror shim re-exports basicSetup + each language + oneDark so everything bundles into **one** `vendor/codemirror.mjs` (no @codemirror/* externals — duplicate `@codemirror/state` instances break CM6).
- `index.html` import map entry → `npm run vendor && npm run csp && npm run build:sw`, commit `vendor/` (pin rule in revision-2.md:29). CM6 is CSP-safe (no eval).
- New `src/components/code-editor.js`: `createCodeEditor(container, {value, language, readOnly, onChange})` — language map ('python'|'javascript'|'typescript'|'java'|'cpp'|'c'|'html'|'css'|'sql'|'plain'); theme via `EditorView.theme` on CSS custom properties + compartment swapping `oneDark` when `<html>` has `sl-theme-dark` (MutationObserver; app toggles at main.js:769).
- Same file: `createCodeViewer(container, {value, language, comments, onLineClick})` — `EditorState.readOnly.of(true)` + `lineNumbers()` + custom comment gutter + line decorations.
- Also build a **pure renderer** `renderCodeWithComments(file, comments)` (escaped `<pre>` line rows with interleaved comment blocks) — needed regardless for the student feedback view and tests.
- **Fix `renderSTEMMarkdown`** (src/core/sanitizer.js:230): extract fenced/inline code spans to placeholders *before* the math pass so `$` inside code blocks stops rendering as KaTeX. Keep `language-*` class allowance (sanitizer.js:74).
- Tests: wrapper create/destroy, getValue/setValue, language switch, readOnly, gutter markers, sanitizer code-vs-math fix; vendor-pipeline test asserting `vendor/codemirror.mjs` in import map + sw-assets. (jsdom needs small stubs like `Range.getClientRects` — add to tests setup.)

### 3b. DrawBoard (dependency-free extension of SketchCanvas)
- New `src/components/draw-board.js` + `draw-board-ui.js` (toolbar: tool select, color swatches via `sl-color-picker`, fill toggle, stroke width, text size, undo/redo, clear, zoom-to-fit). Flashcards' `src/modules/flashcards/sketch-canvas.js` stays untouched; reuse its proven pointer-capture code.
- Data model (`DrawDocSchema` in validator.js): `{version: 2, width: 1000, height: 600, elements: [{id, type:'stroke', color, size, points[[x,y,p]]} | {id, type:'shape', shape:'rect'|'ellipse'|'line'|'arrow', x,y,w,h, color, fill, size} | {id, type:'text', x, y, text, color, fontSize}]}`. `normalizeSketchData()` wraps legacy `{strokes:[]}` for compat with existing `StrokeSchema` (validator.js:27).
- Tools: pen, eraser (element hit-test delete), select (move/Delete key), drag-to-size shapes, text via floating input overlay committed on blur. Undo/redo as an op stack (add/remove/move/edit, 50 steps).
- `renderElementsToCanvas(ctx, doc)` static for thumbnails/toDataURL; **annotation mode**: `DrawBoard({baseDoc /* read-only student work */, doc /* teacher overlay */})` — student work never mutated.
- v1 exclusions: rotation, grouping, images-on-canvas.
- Tests (pure logic, jsdom-friendly): hit tests, undo ops, legacy normalize, schemas.

### 3c. Student CDN uploads (relay server + client)
Server (`server/relay/handler.js` + Cloudflare `worker.js` variant):
- New `POST /api/v1/drops/:dropId/media/presign`, auth via existing `dropSecretOk` (X-KB-Drop-Secret header, line ~349; same pattern as drafts endpoints). Body `{sha256, mime, ext, size}`. Enforce MIME/ext allowlist, per-file cap (default 25MB), **per-drop quota** (count + total bytes; pattern of draft quota at ~460). Prefer relay-proxied upload URL for students (same origin → no CSP change).
- **Fix the `PUT /media/upload` auth hole (line 265):** presign responses (teacher + student) gain `&exp=<unix>&sig=<HMAC(key|exp)>`; PUT verifies sig+expiry, then hashes the body and rejects on sha256 mismatch (key format already embeds the hash). Signing secret generated at relay init, stored in DB meta, overridable via `KB_MEDIA_SIGNING_SECRET`. Teacher clients unaffected (they echo `upload_url` opaquely, media.js:262).
- `/health` already public and lists `'media'` — unchanged.

Client:
- `src/modules/tasks/publish.js`: at publish, probe health and set `payload.relay.media = {enabled, max_file_bytes, max_files, accept[]}` — student-side CDN detection is offline-checkable from the payload (fallback: live health probe when flag absent).
- New `src/utils/student-media.js`: `uploadStudentFile(file, relayInfo)` — refactor the AES-GCM + sha256 core out of `uploadMediaToCdn` (src/utils/media.js:221) into shared helpers; presign via the drop endpoint; **encryption unconditional**; returns `kb-cdn+aes://` ref. Teacher review resolves via existing `resolveMediaSrc` (media.js:134) → `blob:` URLs (already in img-src; no CSP change).
- Docs: `server/relay/README.md` + `docs/it-deployment.md` (KB_CDN_* vars + signing secret are currently undocumented), `wrangler.toml` MEDIA_BUCKET example.
- Tests: handler unit tests (secret required, sig/expiry/hash verification, quotas — patterns in `tests/phase36-relay-sync-ux-and-cdn.test.js`); client round trip encrypt→upload→resolve with mocked fetch.

---

## Phase 4 — Teacher authoring, library, publish (`#/assignments`)

- `src/modules/tasks/index.js`: route dispatch (`#/assignments`, `/create`, `/work`, `/review` — **disjoint from legacy `edit/take/submissions`** so Phase 1 redirects stay unconditional); library via `ProjectLibraryView` (`moduleType:'tasks'`, title "Assignments", `itemTypeName:'Assignment'`, distinct accent/icon, metadata summary = enabled types + pts + submission count).
- `src/modules/tasks/editor.js` (route `#/assignments/create?id=`), pattern of assignments/editor.js:38 (400ms debounced autosave):
  - Title + **description via `RichTextEditor`** (src/components/rich-text-editor.js:8 — math/chem toolbar, preview via `renderSTEMMarkdown`).
  - Submission-type toggle cards with per-type options; **generic-files toggle disabled with hint unless `await isCdnUploadConfigured()`** (src/core/transport.js:439); re-check at publish and force-disable in payload if CDN went away.
  - Grading section: scoring radio (points/proficiency) copied from gradebook/assignment-dialog.js:88, category select, rubric `sl-select` from `gradebook_rubrics` (course-filtered), standards multi-select via `getStandards(course)` (grading-scales.js).
  - Due date/time → `setDue('task', id, {date, time})`; class link → `syncContentClassLink(item, 'tasks', classId)`; Preview → take view with `?preview=`.
- `src/modules/tasks/publish.js`: dialog cloned from assignments/publish.js:132 (validate ≥1 type enabled; warn if files enabled but CDN gone); `publishTask` mirrors publishAssignment:64 — version bump, salt, roster_checks/cards, relay drop, link/QR/.kbshare(.html) outputs, `cdn_student_upload` + `relay.media` flags.
- `src/core/due-dates.js`: `'task'` branches in `getDue`/`setDue` (:8, :54; column sync 114-123, course_items 125-135).
- Register routes (main.js:131-159), `ROUTE_TITLES`, teacher nav entry "Assignments" (coordinate command-palette names: "Assessments" vs "Assignments").
- Tests `tests/phase39-tasks-authoring.test.js`: autosave; class link creates column with correct scoring/rubric_id/max_score/source; unlink deletes; setDue propagates; publish strips private material; files stripped when CDN off.

## Phase 5 — Student take & submit (text + in-app code)

- `src/modules/tasks/take.js` (route `#/assignments/work`): `resolvePayload` clone of assignments/take.js:30 (ephemeral type `'task'`, `student_items`, preview, sessionStorage); start screen with name/ID/access-code (`checkTaskAccessCode`); **composer** = stacked sections per enabled type: RichTextEditor for text; code section via `createCodeEditor` (language select from payload, file tabs add/rename/delete); **live envelope size meter** (pattern: publish-meter, publish.js:380) — green < 180KB plaintext.
- Size budget rules: text ≤32KB soft; code ≤64KB/file, 128KB total; relay POST enforces ~180KB plaintext; `.kbsub`/`.kbsub.html` download path allows 5MB soft budget; QR offered only ≤ ~3KB serialized.
- Drafts: localStorage (full fidelity) + `DraftRoamer` reuse (generalize draft-roaming.js coupling if trivial, else wrap) with 64KB rule — roam everything except strokes when over.
- Submit → `createTaskSubmission` → hand-in sheet: relay (`RelayTransport.submitToDrop`, transport.js:212), `.kbsub` download, `.kbsub.html`, QR (size-gated), mailto; receipt + `StudentLedger.recordSubmission` (src/modules/student/ledger.js:252).
- `src/router.js` `_activateSharedPayload`: `type==='task'` → student_items kind `'task'` → `#/assignments/work`; include `'task'` in the `isStudent` check (line 518) and ephemeral-banner suppression (line 562).
- `src/modules/student/course-store.js` + `course-detail.js`: surface `kind:'task'` items with launch URL + due badge; ledger displays task rows.
- Tests `tests/phase40-tasks-take.test.js`: composer→submit→decrypt round trip; draft save/restore + publish_version change prompt; size meter gates relay but not file download; QR gating; ledger row.

## Phase 6 — Drawing + file attachments in the composer

- Drawing section: `DrawBoard` in composer; inline **lz-string-compressed** DrawDoc (`compressed` field); if compressed > 96KB → rasterize (`renderElementsToCanvas` → PNG) and upload to CDN (`png_ref`); no CDN → downscale PNG to fit active budget; `.kbsub` path may embed `data:`.
- Attachments section: file input filtered by `accept`, per-file progress, `uploadStudentFile` (encrypted), list with remove. Generic files **hidden entirely** when `relay.media` absent; code-file uploads ≤64KB text inline, larger treated as generic files. Offline: attaching requires connectivity — fail gracefully with retry.
- Tests `tests/phase41-tasks-media.test.js`: stroke-budget tiering deterministic with injected sizes; envelope carries refs not bytes; `.kbsub` data:-embed round trip through importer.

## Phase 7 — Teacher review & grading platform

- `src/modules/tasks/submissions.js` (route `#/assignments/review?id=`): By-Student roster board adapted from assignments/submissions.js:47 — submitted/missing/identity chips, days-late, import panel (paste / `.kbsub` file / pull relay drop → `evaluateTaskSubmission`), `is_latest` on resubmit keyed `[task_id+student_id]`, "resubmitted after feedback" badge when a newer submission postdates `returned_at`.
- `src/modules/tasks/review.js`: **full-page review screen** (code needs width; not a drawer).
  - Left pane tabs: rendered `text_md`; `createCodeViewer` with comment gutter (click line → comment composer; comments as line widgets → `review.code_comments`); drawing viewer (`DrawBoard` annotate mode → `review.drawing_annotations`); attachments via `resolveMediaSrc` (inline img/PDF iframe preview, download otherwise).
  - Right pane: grading panel reusing `GradeDetailsDrawer` building blocks — **extract its rubric/standards/status sub-renderers into `src/modules/gradebook/grade-widgets.js`** and consume from both (small safe refactor). Status buttons, points input with late-policy preview (`normalizeScore`), rubric scoring via `RubricScorer.calculateScore` scaled to `max_points` (grade-drawer.js:112-120 pattern), per-standard level buttons + comments, feedback snippets, overall feedback (RichTextEditor), prev/next student nav.
- Gradebook sync (modeled on submissions.js:799): `upsertLinkedColumn` (with scoring/rubricId) then `GradebookBridge.writeGrade` with `rawScore = review.points` + extras (`rubric_eval`, `rubric_comments`, `standard_scores`, `standard_comments`, `days_late`, `source_submission_id`, `feedback_link`) so gradebook cells open fully populated. **Only sync submissions with `reviewed_at` set** (mitigates the known writeGrade-overwrites-teacher-edits issue; don't attempt a full fix here).
- Tests `tests/phase42-tasks-review.test.js`: import paste/file; resubmission flips is_latest; code comments CRUD + `renderCodeWithComments` escapes hostile input; rubric scaling; proficiency writes standard_scores; sync creates one column + grade extras. Regression: `phase5-gradebook`, `unified-sharing-grading` suites still green (bridge changes touch the Assessments path).

## Phase 8 — Feedback return & student display

- `src/modules/tasks/feedback-link.js`: `buildTaskFeedbackPayload` — fully self-contained (offline-renderable): grade (points/standards with labels+colors), full rubric snapshot with eval+comments, overall feedback, **echoed code files with line-anchored comments**, text echo, drawing (student + teacher layers, compressed), attachment refs. No roster/teacher-key material. `createTaskFeedbackLink` reusing `LinkBuilder.feedback` (generalize kind stamp in core/links.js).
- `src/modules/tasks/feedback-view.js`: student rendering — grade header, rubric grid, feedback, `renderCodeWithComments`, drawing with annotation overlay, attachments.
- Bulk-return dialog (pattern submissions.js:860); feedback-PDF ZIP optional (render code+comments, drawing PNG via `renderElementsToCanvas`).
- `_activateSharedPayload` + `#/feedback` route: `kind:'task_feedback'` → `StudentLedger.ingestTaskFeedback` (sibling of ingestAssignmentFeedback, ledger.js; merge by `[course_id+task_id]`, `item_type:'task_feedback'`) → student gradebook shows returned grade.
- `src/modules/inbox/index.js`: classify task envelopes by `task_id` (~47), "Open in Assignment" action, include task drops in relay pull (~292).
- Tests `tests/phase43-tasks-feedback.test.js`: payload self-contained (renders with empty DB), no secret material; ledger ingest/merge; inbox classification & pull.

## Phase 9 — Integration sweep

- Calendar: `calendar/model.js:9` load `tasks` (due from `settings.due_date/time`, points from `grading.max_points`); `calendar/index.js:17` launch URLs (teacher `#/assignments/create?id=`, student `#/assignments/work?id=`), label/icon.
- Courses: `course/render.js:361-420` add-item dialog + `course-feed.js` + `student/course-store.js` — Task as `course_items.kind` (**whitelist payload fields; do not reproduce the course-feed answer-key leak pattern**).
- `src/core/content-importer.js:391-410`: `importRecordToLibrary('task', …)` (reset publish/column_id, re-id, sanitize).
- `gradebook/assignment-dialog.js:65-69`: "Linked tool" gains Assignment (task) option + picker.
- Extend `tests/comprehensive-sharing-matrix.test.js` + `universal-content-import.test.js` with `task`; calendar + course round-trip tests.
- Final: full `npm test`, `npm run build`, grep QA gate re-run.

---

## Verification (end-to-end)

1. `npm test` green after every phase; `npm run build` (tailwind + csp + sw) after vendor/index.html changes.
2. Manual smoke via `node server.js` + browser (or the `run` skill):
   - Rebrand: nav shows Assessments + Assignments; old `#/assignments/take?...` URL redirects with params; open an existing `.kbshare` assignment link → lands on Assessments take view.
   - Authoring: create Assignment with math/chem in description, enable text+code+drawing; files toggle disabled until a relay with CDN is connected (relay dev: `KB_CDN_LOCAL_DIR=... node server/relay/index.js`); link to class → gradebook column appears with chosen scoring/rubric.
   - Student: open publish link in a private window → write text with an equation, code with highlighting, draw with shapes/text; watch size meter; submit via relay drop and via `.kbsub.html` download; attach a PDF (CDN on) and confirm the relay stores only ciphertext.
   - Review: pull drop → open review page → inline comments on code lines, annotate drawing, score with rubric → Save & sync → gradebook cell shows score, rubric eval, feedback; return feedback link → open as student → grade, inline code comments, annotated drawing all render; resubmit → badge shows.
   - Calendar shows the due date in both roles; course page can add the Assignment.

## Risks

- **Kind string `task` is permanent in wire formats** from first publish — locked by this plan; don't rename later.
- **256KB relay ceiling**: stroke-heavy drawings with no CDN are the riskiest path; mitigations are the size meter, PNG tiering, and the `.kbsub.html` 5MB escape hatch. Test on a stylus device.
- **Bridge changes touch the live Assessments sync path** — regression suites are mandatory in Phase 7.
- **CM6 under jsdom** needs test stubs; keep comment anchoring/size tiering/renderers as pure modules (repo's existing pure-pipeline test philosophy).
- Lightly assignment-shaped helpers (`DraftRoamer`, `LinkBuilder.feedback`, `checkAccessCode`): prefer generalizing in place with default params; copy only if the diff risk to the live module is nontrivial — decide per file when touched.
- Known pre-existing issues documented but out of scope: `#/connect` saves relay URL+token without confirmation; course-feed answer-key leak (avoid the pattern; a proper fix is a separate task).
