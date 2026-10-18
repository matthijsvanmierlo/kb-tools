# KennisBoost Tools — Revision 2 Implementation Plan

**Scope:** rostering and class configuration, collecting student work, returning feedback and exporting CSVs for mail merge, gradebook CSV export with encoded report links, sync-server readiness, and a simplified Home page with a new About page.

**Audience:** the engineer or model that will execute this plan. Every phase lists the files to touch, the contracts to implement, the steps in order, and the acceptance checks. Nothing in this document has been implemented yet.

---

## 0. Ground rules for the executing agent

### 0.1 Baseline (verified on 2026-10-17)

| Item | Value |
|---|---|
| Git HEAD | `14c969c feat: UI polish, assignments module, SBG grading, and secure student hand-in` |
| Node | v22.22.1 (has `node:sqlite` built in; relevant for Phase 6) |
| Tests | `npm test` → 10 files, 94 tests, all passing (vitest 5, jsdom, fake-indexeddb) |
| Build | No bundler. Native ESM + `<script type="importmap">` in `index.html` (CDN). Only build step is Tailwind: `npm run build:css` regenerates the committed `css/tailwind.output.css`. |
| DB | Dexie 4, database `KennisBoostDB`, currently schema version 3 (`src/core/storage.js`) |
| UI kit | Shoelace 2.15 web components (`sl-*`), Tailwind utilities, design tokens in `css/app.css` (`--kb-*`) |
| Routing | Hash router `src/router.js`; routes registered in `src/main.js`; route titles for screen readers in `Router._announceRouteChange` |
| Offline | `sw.js` precaches an explicit `STATIC_ASSETS` list; `CACHE_NAME = 'kennisboost-v5'` |

### 0.2 Non-negotiable conventions

1. **Every new `src/**/*.js` file must be added to `STATIC_ASSETS` in `sw.js`, and `CACHE_NAME` must be bumped once per phase** (v6 after Phase 0, v7 after Phase 1, …). Forgetting this ships a broken offline build.
2. **Run `npm run build:css` after adding any Tailwind utility class** not already present in `css/tailwind.output.css`. Commit the regenerated file.
3. **Run `npm test` after every phase.** Add a `tests/phaseNN-*.test.js` file per phase (numbering continues from `phase10`). Keep tests DOM-free where possible by putting logic in pure modules.
4. **No new runtime npm dependencies** unless also added to the `importmap` in `index.html` with a pinned CDN URL. Server code under `server/` may use Node built-ins only (`node:http`, `node:sqlite`, `node:crypto`).
5. **Every string rendered into HTML goes through `Sanitizer.escapeHTML`** (user content) or `Sanitizer.renderSTEMMarkdown` (markdown prompts). Note the class has both `escapeHtml` and `escapeHTML`; use `escapeHTML` consistently.
6. **No automatic demo data.** Demo content is created only by an explicit "Load demo workspace" action and is tagged `is_demo: true` so it can be removed (see §2.6).
7. **Student secrets never travel in URLs.** Access codes are never placed in a link, a query parameter, or an unencrypted payload. Student IDs may appear in a per-student link that is sent only to that student (`sid` prefill, §6.4).
8. **New routes** require four edits: `router.register` in `src/main.js`, a title in `Router._announceRouteChange`, an entry in `src/components/command-palette.js`, and `sw.js`.
9. **Dialogs and drawers** are appended to `document.body` and must remove themselves on `sl-after-hide` (guarding `e.target === dialog`), matching existing components.
10. **Accessibility:** every interactive element needs a label; tables need `<th>`; status chips need `title`/`aria-label`; keep keyboard navigation working (Shoelace handles most of it).
11. Keep the "zero backend for core operations" promise. Everything added in Phases 0–5 must work with no server. Phase 6 is additive and optional at runtime.

### 0.3 Phase order and dependencies

```
Phase 0  Foundation: defect fixes, DB v4, csv/links/names core modules
   ├── Phase 1  Home simplification + About page            (independent of 2–5)
   ├── Phase 2  Classes, roster import, class setup wizard  (needs 0)
   │     └── Phase 3  Collecting work: Inbox, hand-in UX, student chrome (needs 2 for roster view links)
   │           └── Phase 4  Returning feedback: CSV + feedback links + mail merge (needs 3's import refactor)
   │                 └── Phase 5  Gradebook CSV export/import with report links (needs 4's csv presets)
   └── Phase 6  Sync readiness: outbox, transport, relay reference server (needs 0; UI hooks need 3/4)
```

Phases 1 and 6 can run in parallel with 2–5 on separate branches if desired. Suggested branch names: `rev2/phase-0-foundation`, `rev2/phase-1-home-about`, … Merge in numeric order.

### 0.4 Definition of done (every phase)

- All steps complete, `npm test` green, `npm run build:css` run if needed, `sw.js` updated, no console errors on `#/`, `#/gradebook`, `#/assignments`, `#/inbox`, `#/about` (Phase-dependent).
- Manual smoke test performed in the browser via `npm start` (see per-phase checklist).
- Teacher guide (`src/modules/guide/index.js`) updated for any renamed menu item or new workflow (text in Appendix E).

---

## 1. Audit: how the workflows work today, and what is wrong

### 1.1 Adding students and creating classes

**Entities.** A "class" and a "gradebook course" are the same record in `gradebook_courses` (`src/components/class-manager.js`, `src/modules/gradebook/*`). Students are rows in `gradebook_students` scoped by `course_id`; a student in two classes is two rows with no shared identity. Grades use the compound primary key `[student_id+assignment_id]` (not scoped by course; safe only because assignment IDs are UUIDs).

**Creating a class.** Three entry points, all ending in `ClassManager.saveClass()`:
- Header class dropdown → "Manage Classes…" → "New Class" (`openClassEditorModal`: name, section, year, colour). Default terms/categories are injected silently (`Full Year`; `Assessments 60% / Classwork & Homework 40%`).
- Home → "Create new → Course / Class" (same modal).
- Gradebook → Actions → "New Class…" (opens the manager modal, not the editor).

**Adding students.** Gradebook → "+ Student" (name, ID, email) or Actions → "Import Roster CSV…". The CSV path is **broken** (defects D-01, D-02, D-07, D-08 below): any realistic roster CSV fails validation, and the error dialog itself throws.

**Configuring the gradebook.** Gear icon → `openCourseSettingsDialog` (tabs: General/terms/mode, Categories & policies, Grading scale, Standards, Student access). Access codes are generated here. This dialog is good and is retained; the plan adds entry points and a wizard in front of it, not a replacement.

**Ease-of-use problems.**
- No guided first run. A new teacher lands on a marketing hero and a demo button; the gradebook auto-seeds "AP Chemistry" with five fake students the first time it is opened (D-05), which then pollutes a real workspace.
- Roster import is unusable (D-01). There is no column-mapping, no preview, no de-duplication, no "update existing".
- Students have no first/last name split, so sorting and mail merge ("Dear {FirstName}") are heuristics on `full_name`.
- Class deletion claims to cascade but does not (D-04). Removing a student deletes grades across all classes with the same student ID (D-03).
- The academic year default is hard-coded `2026-2027` (D-11).

### 1.2 Collecting student work

**Assignments.** Teacher publishes (`src/modules/assignments/publish.js`) → key-free payload in a `#/share?enc=&d=` link or `.kbshare` file → student opens link, enters name/ID/access code (`take.js`) → answers → results screen offers "Download submission file" (`.kbsub`) or "Copy submission code" (`KBSUB1.…`) → student uploads to the LMS → teacher downloads files → Assignments → Submissions → "Import .kbsub files" / "Paste codes" → `evaluateSubmission` decrypts, verifies identity, re-grades → review drawer → "Sync to gradebook" (`GradebookBridge`).

**Video.** Share dialog → kiosk → encrypted `.kbr` receipt → Gradebook → Actions → "Import .kbr Video Receipts…" (code in `src/modules/gradebook/index.js` lines ~608–736, not reusable).

**Problems.**
- Two different inboxes in two different modules; the teacher must know which file type goes where and pick the assignment before importing, even though every envelope already carries an unencrypted routing header (`header.assignment_id` for assignments; `header.kind === 'video-receipt'` and `header.assessment_id` for receipts).
- LMS bulk downloads arrive as a ZIP; there is no ZIP ingestion.
- Students see the full teacher navigation (Flashcards, Gradebook, …) while taking an assignment (D-10). This is confusing and invites clicking into empty teacher views.
- No "hand-in instructions" text for the LMS post; teachers write it by hand.
- No per-student link prefill, so students mistype IDs; no list of who has not submitted.
- Mobile students have no Web Share path to send the `.kbsub` to Drive/Mail/Classroom.

### 1.3 Returning feedback and reporting

What exists: per-student encrypted grade-report link (`GradebookReportGenerator.createStudentShareLink`, one student at a time via a select dialog), single PDF, batch ZIP of PDFs, assignment feedback synced into the gradebook grade's `feedback` string.

What does not exist: any CSV of grades; any CSV of submissions; a per-assignment feedback link showing the student their answers with comments; bulk generation of report links; any mail-merge-ready output. `AccessCodes.toCSV` is the only CSV writer and it is hand-rolled (no BOM, LF endings, no injection guard).

### 1.4 Backup and sync

`src/core/sync.js` writes a full JSON snapshot to a File System Access handle (5 s debounce) and nags after 72 h. It is a backup mechanism, not a sync protocol. `storage.onMutation` exists (Dexie hooks) but is only used to trigger the backup. Records lack consistent `created_at`/`updated_at`; grades have no `id`. There is no change log, no device identity, no transport abstraction.

### 1.5 Home and guide

`src/modules/home/index.js` (716 lines) renders: marketing hero (demo + create + open file + guide), six stat cards, recent projects, five "capability" marketing cards, a three-step "How it works", and the demo seeding code. `src/modules/guide/index.js` is a good workflow manual and stays. There is no About page.

### 1.6 Defect register

| ID | Where | Problem | Fix in |
|---|---|---|---|
| D-01 | `src/core/validator.js` `HEADER_ALIASES` + `GradebookStudentSchema` | Aliases map roster headers to `fullName`/`studentId` (camelCase) but the schema requires `full_name`/`student_id`, plus `id` and `course_id` UUIDs that a CSV never contains. **Every roster CSV import fails.** Verified by running `parseCSVWithValidation('Student Name,Student ID,Email\n…', GradebookStudentSchema)` → 8 errors. | Phase 0 |
| D-02 | `src/core/validator.js` ~line 297 | `showImportErrorsDialog` calls `Sanitizer.escapeHtml` but `Sanitizer` is not imported → `ReferenceError`; the user sees only "Import failed." | Phase 0 |
| D-03 | `src/modules/gradebook/index.js` ~line 367 | Removing a student runs `gradebook_grades.where('student_id').equals(id).delete()` with no course scope; deletes that ID's grades in every class. | Phase 0 |
| D-04 | `src/components/class-manager.js` `deleteClass` | Confirm text says students and grades are removed; code deletes only the course row. Orphans students, assignments, grades, rubrics, and `assignments.gradebook.course_id` links. | Phase 0 |
| D-05 | `src/modules/gradebook/index.js` lines ~29–117; `src/modules/assignments/seed.js` via `assignments/index.js:22`; Home demo seeding | Demo data is auto-created in real workspaces and cannot be told apart from real data. | Phase 0 (gate) + Phase 1 (move) |
| D-06 | `src/modules/home/index.js:44` | Reads `last_backup_timestamp`; `sync.js` writes `last_manual_export_timestamp`. | Phase 1 |
| D-07 | Roster import, `gradebook/index.js` ~592 | Re-importing the same CSV creates duplicate students (new UUID per row, no match on `student_id`). | Phase 2 |
| D-08 | `GradebookStudentSchema.email` | `z.string().email().optional()` rejects the empty string that a blank CSV cell produces. Also `dynamicTyping: true` turns IDs like `000123` into `123`. | Phase 0 |
| D-09 | `src/core/sync.js` `_updateSyncIndicator` | Targets `#sync-status-indicator`, which does not exist in `index.html`. | Phase 6 |
| D-10 | `src/router.js` `_activateSharedPayload` | Student-facing views keep the teacher header, nav, class selector and backup menu. | Phase 3 |
| D-11 | `src/components/class-manager.js` ~line 68 | Academic year default hard-coded to `2026-2027`. | Phase 0 |
| D-12 | `src/core/storage.js` memory shim | Ephemeral-mode table shim lacks `count()` (used by `seed.js`), `bulkDelete()`, and compound-key `get([a,b])` (used by `GradebookBridge.writeGrade`). | Phase 0 |
| D-13 | `src/core/validator.js` `HEADER_ALIASES` | Global alias `'id' → 'studentId'` rewrites any CSV's `id` column (timelines, flashcards). Aliases must be per-schema. | Phase 0 |
| D-14 | `sw.js` fetch handler | Caches every same-origin GET; will cache `/api/*` responses once a relay exists. | Phase 6 |

---

## 2. Target architecture: cross-cutting decisions

### 2.1 Data model v4

Add a Dexie version 4 in `StorageManager` constructor (`src/core/storage.js`). Only changed tables need to be listed.

```js
this.db.version(4).stores({
  gradebook_courses:      'id, name, section, academic_year, updated_at, archived_at',
  gradebook_students:     'id, course_id, student_id, full_name, email, updated_at, [course_id+student_id]',
  gradebook_assignments:  'id, course_id, term_id, category_id, due_date, updated_at',
  gradebook_grades:       '[student_id+assignment_id], id, course_id, student_id, assignment_id, status, updated_at',
  gradebook_rubrics:      'id, course_id, title, updated_at',
  assignments:            'id, title, class_id, updated_at',
  assignment_submissions: 'id, assignment_id, student_id, submitted_at, synced_at, updated_at, [assignment_id+student_id]',
  flashcards:             'id, title, class_id, updated_at',
  timelines:              'id, title, class_id, updated_at',
  video_assessments:      'id, title, class_id, updated_at',
  outbox:                 '++seq, table, op, created_at, pushed_at'   // used from Phase 6; created now so the migration happens once
}).upgrade(async (tx) => {
  const now = new Date().toISOString();
  const stamp = (r) => { r.created_at = r.created_at || r.updated_at || now; r.updated_at = r.updated_at || now; };
  for (const name of ['gradebook_courses','gradebook_students','gradebook_assignments','gradebook_rubrics','assignments','assignment_submissions','flashcards','timelines','video_assessments']) {
    await tx.table(name).toCollection().modify(stamp);
  }
  await tx.table('gradebook_grades').toCollection().modify((g) => { g.id = g.id || crypto.randomUUID(); stamp(g); });
  await tx.table('gradebook_students').toCollection().modify((s) => {
    if (!s.given_name && !s.family_name && s.full_name) { const n = splitName(s.full_name); s.given_name = n.given; s.family_name = n.family; }
  });
});
```

New/changed fields (document in Zod schemas in `src/core/validator.js`):

| Table | Field | Purpose |
|---|---|---|
| all data tables | `created_at`, `updated_at` (ISO strings) | sync ordering, "recent" lists, LWW conflict rule |
| `gradebook_courses` | `archived_at: string\|null` | hide old classes without deleting; academic-year rollover |
| `gradebook_courses` | `is_demo?: true` | demo workspace removal |
| `gradebook_students` | `given_name`, `family_name` (optional), `sis?: { source, sourced_id }` | mail merge salutations, sorting, SIS round-trip |
| `gradebook_grades` | `id` (UUID; compound PK unchanged) | stable identity for sync |
| any seeded record | `is_demo?: true` | demo removal |
| `outbox` | `{ seq, table, key, op: 'put'\|'delete'\|'clear', record?, created_at, pushed_at: null }` | Phase 6 change log |

Also add to `app_metadata`: `device_id` (UUID, created on first boot), `schema_version` (4), `teacher_profile` (`{ display_name, email }`, optional, used in hand-in instructions and relay auth).

### 2.2 Write path: a stamping wrapper around `storage.table()`

Modules call `storage.table(name).put(record)` directly (dozens of call sites). Rather than refactor them, make `StorageManager.table(name)` return a thin wrapper for data tables that:

1. Stamps `updated_at = now`, `created_at ??= now`, `id ??= generateUUID()` on `put`/`bulkPut` (for `gradebook_grades` the compound PK stays; `id` is additive).
2. Delegates everything else to the underlying Dexie table (`get`, `where`, `toArray`, `count`, `toCollection`, …) via a `Proxy` whose `get` trap returns bound functions of the target.
3. (Phase 6) writes an `outbox` row inside the same transaction: `db.transaction('rw', db[name], db.outbox, async () => { await db[name].put(rec); await db.outbox.add({...}); })`.

The memory shim used in ephemeral mode gets the same surface (`get` with array keys joined by `+`, `count`, `bulkDelete`, `where(field).equals(v).{toArray,delete,count}`, `toCollection().modify(fn)`).

Known collection-level deletes that bypass the wrapper (must be converted to `bulkDelete` of explicit keys so they can be logged in Phase 6): `src/modules/gradebook/index.js` lines ~367 and ~405. Grep for `.delete()` and `.modify(` under `src/modules` before Phase 6 and convert any others.

### 2.3 New core modules

| File | Exports | Notes |
|---|---|---|
| `src/core/csv.js` | `toCSV(rows, columns, opts)`, `parseCSV(text, opts)`, `guardCell(v)`, `downloadCSV(filename, text)`, `suggestDelimiter()` | Single CSV writer for the whole app. UTF-8 BOM on by default, CRLF line endings, quote every text field, `"`→`""`, CSV-injection guard (prefix `'` to cells starting with `= + - @ \t \r`), ISO dates, number formatting with `decimal` option (`.` or `,`), `delimiter` option (`,` or `;`). `suggestDelimiter()` returns `;` for `nl`, `de`, `fr`, `es`, `it`, `pt`, `da`, `sv`, `fi`, `nb`, `pl`, `cs`, `tr` locales (Excel list separator), otherwise `,`; always user-overridable. `parseCSV` wraps PapaParse with `dynamicTyping: false`, `skipEmptyLines: 'greedy'`, delimiter auto-detect, header trim, and returns `{ fields, rows, errors }`. |
| `src/core/names.js` | `splitName(full) → { given, family }`, `joinName({given, family})`, `sortKey(student)` | Handles `"Last, First"`, `"First Middle Last"`, and surname particles (`van`, `van der`, `de`, `den`, `von`, `da`, `del`, `di`, `la`, `le`, `du`, `ter`, `ten`) so "Matthijs van Mierlo" → `{ given: 'Matthijs', family: 'van Mierlo' }`. Pure, unit-tested. |
| `src/core/links.js` | `LinkBuilder` (see §6.4, §7.3, §8.2) | One place that knows the `#/share?enc=&d=` format, appends extra params (`sid`), measures length, and (Phase 6) produces hosted `ref`/`k` links. `CryptoShareEngine.createSharePayload` remains the encoder; `LinkBuilder` composes it. |
| `src/core/academic-year.js` | `defaultAcademicYear(date = new Date())` | Aug–Jul convention: `2026-08-01` → `"2026-2027"`, `2027-03-01` → `"2026-2027"`. Replaces hard-coded strings (D-11). |
| `src/core/demo.js` | `loadDemoWorkspace()`, `removeDemoData()`, `hasDemoData()` | Moves seeding out of Home and Gradebook; every record it writes has `is_demo: true`. |
| `src/core/transport.js` | `SyncTransport` interface, `NullTransport`, `getTransport()` | Phase 6. |

### 2.4 Student mode chrome

`src/router.js` sets `document.body.dataset.mode = 'student'` whenever the active view is student-facing (`ephemeralData.type` ∈ `assignment`, `video` with `payload.secure`, `student_grade_report`, `assignment_feedback`, or route `#/assignments/take` without `preview`), and removes it on any other route. CSS in `css/app.css`:

```css
body[data-mode="student"] .kb-nav,
body[data-mode="student"] #kb-nav-class-selector,
body[data-mode="student"] #btn-open-cmd-palette,
body[data-mode="student"] #btn-open-cmd-palette-mobile,
body[data-mode="student"] .kb-guide-link,
body[data-mode="student"] .kb-storage-menu,      /* add this class to the backup dropdown in index.html */
body[data-mode="student"] .kb-footer-tags { display: none !important; }
body[data-mode="student"] .kb-brand-name span::after { content: ' · Student'; }
```

The theme switcher stays (dark mode for students). The brand link in student mode points to `#/assignments/take` or the current view rather than `#/` (set `href` in the router when toggling the mode).

### 2.5 Route map after Revision 2

| Route | Module | Status |
|---|---|---|
| `#/` | `src/modules/home/index.js` | rewritten (Phase 1) |
| `#/about` | `src/modules/about/index.js` | new (Phase 1) |
| `#/guide` | unchanged, text updates | |
| `#/gradebook` (+ `?view=grades\|standards\|roster`) | `src/modules/gradebook/index.js` + `roster-view.js` | roster view added (Phase 2) |
| `#/inbox` | `src/modules/inbox/index.js` | new (Phase 3) |
| `#/feedback` | `src/modules/assignments/feedback-view.js` | new student view (Phase 4) |
| `#/assignments/take` | unchanged route, `sid` prefill + hand-in options | Phase 3 |
| `#/share` | router | `ref`/`k` hosted links (Phase 6) |

### 2.6 Demo data policy

- Remove the auto-seed in `renderGradebookView` (lines ~29–117), the call to `ensureSampleAssignment()` in `renderAssignmentsView`, and the seeding code in `renderHomeView`.
- Move all seeding into `src/core/demo.js: loadDemoWorkspace()`; reuse the existing seed content (AP Chemistry class with 5 students and grades, Stoichiometry assignment, chemistry deck, history timeline, entropy video). Every record gets `is_demo: true`; the function also writes `app_metadata.demo_loaded_at`.
- `removeDemoData()` deletes every record with `is_demo: true` across all tables (and `assignment_submissions` whose `assignment_id` is a demo assignment).
- Entry points: About page ("Try it with sample data" / "Remove sample data"), Home empty state ("Load sample workspace"), command palette.
- Demo records show a small "Sample" chip in libraries and the class dropdown (`ClassManager.renderClassBadge` gains an `is_demo` variant).

### 2.7 Standards and compliance alignment

| Area | Adopt now (Phases 0–5) | Prepare for (Phase 6 and later) |
|---|---|---|
| Rostering | OneRoster 1.1 CSV import (`users.csv`, `classes.csv`, `enrollments.csv`); generic CSV with column mapping; `sis.sourced_id` kept on students/classes | OneRoster REST 1.1/1.2 consumer, Clever/ClassLink, Google Classroom API (server-side) |
| Grades | Generic wide CSV (round-trippable), Canvas-compatible CSV export, OneRoster `results.csv` export | LTI 1.3 Assignment and Grade Services (AGS) passback |
| Assessment content | Keep internal JSON | QTI 3.0 export of assignments (optional later) |
| Privacy | FERPA/GDPR data minimisation: PII only in encrypted payloads or in files the teacher explicitly exports; exports show a PII warning; access codes never in links; "remove student" also purges submissions | DPA template for school-hosted relay; retention settings; right-to-erasure endpoint |
| Accessibility | WCAG 2.1 AA maintained (Shoelace, labels, focus order, `aria-live` announcements) | — |
| Interop files | `.kbshare`, `.kbsub`, `.kbr` unchanged; `.zip` ingestion | Hosted payload refs |

---

## 3. Phase 0 — Foundation and defect fixes

**Goal:** make the data layer trustworthy and give later phases shared primitives. No visible feature changes except that roster import works and demo data stops appearing uninvited.

### 3.1 Files

Create: `src/core/csv.js`, `src/core/names.js`, `src/core/academic-year.js`, `src/core/demo.js`, `tests/phase11-foundation.test.js`.
Modify: `src/core/storage.js`, `src/core/validator.js`, `src/components/class-manager.js`, `src/modules/gradebook/index.js`, `src/modules/assignments/index.js`, `src/modules/home/index.js` (seed removal only; full rewrite is Phase 1), `src/main.js`, `sw.js`, `package.json` (version → `1.1.0`).

### 3.2 Steps

1. **DB v4 migration** exactly as in §2.1. Import `splitName` from `names.js` into `storage.js` for the upgrade. Add `'outbox'` to the ephemeral `tables` list and to `dumpMasterSnapshot` exclusions (the outbox is device-local; do not back it up). Add `schema_version: 4` to `app_metadata` at `init()`; create `device_id` if missing.
2. **Stamping wrapper** (§2.2). Implement `wrapTable(rawTable, name)` and the memory-shim parity (D-12). Add unit tests: `put` without `id` gets one; `updated_at` changes on each `put`; `created_at` is preserved; `get([studentId, assignmentId])` works in ephemeral mode.
3. **`restoreMasterSnapshot`**: validate `snapshot.version` and `snapshot.data` shape; wrap in one `db.transaction('rw', ...tables)`; after restore, run the same stamping on records lacking metadata; never restore `outbox`.
4. **Validator fixes (D-01, D-02, D-08, D-13).**
   - Import `Sanitizer` in `validator.js`; use `escapeHTML`.
   - Make aliases per-schema: `parseCSVWithValidation(csv, schema, { aliases = {}, dynamicTyping = true })`. Keep the existing generic map for flashcards/timelines but **remove** the global `'id'`, `'student_id'`, `'student name'`, `'name'` … entries. Export `ROSTER_HEADER_ALIASES` (see Appendix A) mapping to snake_case keys.
   - Add `RosterRowSchema` (a *row* schema, distinct from the storage schema):
     ```js
     const blank = (v) => (v === null || v === undefined || String(v).trim() === '' ? undefined : String(v).trim());
     export const RosterRowSchema = z.object({
       student_id: z.preprocess(blank, z.string().min(1, 'Student ID is required')),
       full_name: z.preprocess(blank, z.string().optional()),
       given_name: z.preprocess(blank, z.string().optional()),
       family_name: z.preprocess(blank, z.string().optional()),
       email: z.preprocess(blank, z.string().email('Invalid email').optional()),
       access_code: z.preprocess(blank, z.string().optional()),
       notes: z.preprocess(blank, z.string().optional())
     }).refine(r => r.full_name || r.given_name || r.family_name, { message: 'A name is required', path: ['full_name'] });
     ```
   - Relax `GradebookStudentSchema.email` with the same `blank` preprocess; add optional `given_name`, `family_name`, `access_code`, `created_at`, `updated_at`, `sis`.
   - Roster parsing always uses `dynamicTyping: false` so IDs keep leading zeros.
   - Keep the `HEADER_ALIASES` export and its flashcard/timeline entries (`question`/`answer`/`term`/`definition`/`start date`/`end date`): `src/modules/flashcards/index.js:183`, `src/modules/timeline/index.js:59` and `:635`, and `tests/phase1-core.test.js` depend on them. Only the roster-specific and bare `id`/`name` entries move into `ROSTER_HEADER_ALIASES`.
5. **Fix the existing roster import call site** in `gradebook/index.js` (~580–606) to use `RosterRowSchema` + `ROSTER_HEADER_ALIASES` + `dynamicTyping: false`, build the stored record (`id`, `course_id`, `full_name` from `joinName` when only parts are given, `given_name`/`family_name` from `splitName` when only `full_name` is given), and **upsert by `[course_id+student_id]`** (case-insensitive, trimmed) instead of inserting (D-07 minimal fix; the full mapping UI comes in Phase 2).
6. **Scoped student removal (D-03):** in the `onDeleteStudent` handler, fetch grades with `where('[student_id+assignment_id]')` is not available; instead `where('course_id').equals(course.id).and(g => g.student_id === student.student_id).primaryKeys()` then `bulkDelete(keys)`. Also delete that student's `assignment_submissions` for assignments linked to this course (`assignments.gradebook.course_id === course.id`), and inform the user in the confirm text.
7. **Cascade class deletion (D-04):** `ClassManager.deleteClass(id)` deletes in one transaction: students, assignments (gradebook columns), grades, rubrics of the course; sets `class_id = null` / `gradebook.course_id = null` on `flashcards`, `timelines`, `video_assessments`, `assignments` that reference it; deletes `assignment_submissions` of assignments that were linked to this course **only** when the teacher ticks "also delete collected submissions" in the confirm dialog (default unchecked; otherwise they stay with the assignment). Add an **Archive** action instead of delete as the recommended path (`archived_at`); archived classes are hidden from the header dropdown, class filters, and setup lists unless "Show archived" is toggled in the Class Manager.
8. **Academic year default (D-11):** replace both `'2026-2027'` defaults in `class-manager.js` with `defaultAcademicYear()`; keep `GradebookCourseSchema.academic_year` default via the same function.
9. **Demo gating (D-05):** remove the three auto-seed paths; create `src/core/demo.js` with the moved seed code plus `is_demo: true`. Temporarily keep a "Load sample workspace" button on the current Home (Phase 1 relocates it).
10. **Create `csv.js`, `names.js`, `academic-year.js`** per §2.3 with tests. Replace `AccessCodes.toCSV` internals with `csv.toCSV` (same columns).
11. `sw.js`: add new files, bump to `kennisboost-v6`.

### 3.3 Tests (`tests/phase11-foundation.test.js`)

- v4 upgrade: open a fake-indexeddb DB at v3 with a grade row lacking `id`/timestamps, open at v4, assert fields exist (`fake-indexeddb/auto` + `new StorageManager()`).
- Wrapper stamping and memory-shim parity.
- `RosterRowSchema` accepts `Student Name,Student ID,Email` with blank emails and preserves `000123`.
- `csv.toCSV` output starts with BOM, uses CRLF, escapes quotes, guards `=SUM(1)` cells, honours `;` delimiter and `,` decimal.
- `splitName` cases including particles and `"Last, First"`.
- `defaultAcademicYear` on both sides of August.
- `deleteClass` cascade and `onDeleteStudent` scoping (two courses sharing a student ID: only one course's grades removed).

### 3.4 Smoke test

Import a CSV with headers `Last Name,First Name,Student ID,Email` into a class; re-import the same file and confirm no duplicates; remove a student; delete a class and confirm no orphan rows via the storage-info dialog counts (add table counts to that dialog while here).

---

## 4. Phase 1 — Home simplification and About page

**Goal:** Home becomes a working dashboard for a returning teacher; everything explanatory moves to `#/about`.

### 4.1 Files

Create: `src/modules/about/index.js`, `src/components/setup-checklist.js`, `tests/phase12-home-about.test.js`.
Modify: `src/modules/home/index.js` (rewrite), `src/main.js`, `src/router.js`, `src/components/command-palette.js`, `index.html` (header help menu, footer), `sw.js` (v7), `css/app.css`.

### 4.2 Home page specification (`#/`)

Render order, top to bottom. Each section is a function returning HTML so the file stays under ~400 lines; event binding in one `bind()`.

1. **Context bar.** Left: "Home" + today's date + active class chip (from `ClassManager.getActiveFilter()`), right: `New ▾` dropdown (Assignment, Video assessment, Flashcard deck, Timeline, Class), `Import student work` (→ `#/inbox`, Phase 3; until then opens the Assignments library), `Backup` (calls `sync.exportManualBackup`).
2. **Setup checklist** (`SetupChecklist.render(container, stats)`), shown until all items are done or the teacher dismisses it (`app_metadata.setup_checklist_dismissed_at`). Items and their completion predicates:
   - Create a class → `courses.some(c => !c.is_demo)`
   - Add your students → `students.some(s => !s.is_demo)`
   - Generate access codes → every non-demo student has `access_code`
   - Publish an assignment or video → any non-demo `assignments[].publish` or `video_assessments[].shared_at` (add `shared_at` stamp in `openVideoShareDialog` on link creation)
   - Make a backup → `app_metadata.last_manual_export_timestamp` set
   Each row has a button that deep-links to the right place (class wizard, roster import, settings `access` tab, assignment editor, backup).
3. **Needs attention.** Only non-empty items are rendered; if none, the section is omitted entirely:
   - `N submissions to review` (latest submissions with `!synced_at` or `finalScore().pending > 0`), grouped by assignment with links to `#/assignments/submissions?id=`
   - `N students without access codes in {class}` → settings access tab
   - `Backup is {days} days old` when > 3 days (reuse `checkStaleBackup` thresholds; fixes D-06 by reading `last_manual_export_timestamp`)
   - `{assignment} due {date}: {submitted}/{roster} handed in` for assignments with `settings.due_date` within the next 7 days and a linked class
   - `Storage {percent}% used` when > 80 %
4. **Quick actions** (6 tiles): New assignment, New video, New deck, New timeline, Open shared file (`.kbshare`/`.kbr`/`.kbsub` → routes to share handler or Inbox), Teacher guide.
5. **Recent projects** (existing code, keep; show 8 instead of 4; include a "Sample" chip for `is_demo`).
6. **Your classes** cards: name/section, students, assignments, pending submissions, three buttons (Gradebook, Roster, Settings). Empty state: "No classes yet → Set up a class" (opens the wizard from Phase 2; until Phase 2 lands, opens `openClassEditorModal`).
7. **Footer line:** "New here? Read how KennisBoost works →" linking to `#/about`.

Removed from Home: hero banner, marketing copy, five capability cards, "How it works", demo seeding code, "Learn about the platform" style content.

### 4.3 About page specification (`#/about`)

Sections: (1) What KennisBoost Tools is (two paragraphs, plain language); (2) Privacy model table — what is stored, where (browser IndexedDB/OPFS), what leaves the device (only links/files you share), what students see; (3) The five tools (reuse the capability card markup removed from Home, trimmed to one sentence + "Open" button each); (4) How it works (the three steps, updated to mention the Inbox); (5) Try it: "Load sample workspace" / "Remove sample data" (calls `demo.js`; shows counts); (6) Keyboard shortcuts (opens the existing `?` dialog via `document.getElementById('menu-btn-keyboard-shortcuts').click()`); (7) Version and credits: version from a new `src/version.js` (`export const APP_VERSION = '1.1.0'`), list of libraries with licences (Shoelace MIT, Dexie Apache-2.0, KaTeX MIT, DOMPurify Apache-2.0/MPL, marked MIT, PapaParse MIT, lz-string MIT, jsPDF MIT, JSZip MIT/GPL dual, Zod MIT, Inter OFL); (8) Links: Teacher guide, GitHub/issue tracker placeholder (`APP_REPOSITORY_URL` constant, may be empty).

### 4.4 Navigation changes

- `index.html`: replace the single guide icon button with a **Help** dropdown (`sl-dropdown`, icon `question-circle`): Teacher guide (`#/guide`), About (`#/about`), Keyboard shortcuts, Load/remove sample data. Footer: "About · Teacher guide". Add class `kb-storage-menu` to the backup dropdown (used by student mode in Phase 3).
- `router.js` titles: `'#/about': 'About KennisBoost Tools'`, `'#/inbox': 'Student Work Inbox'`, `'#/feedback': 'Assignment Feedback'`.
- Command palette: "About KennisBoost", "Load sample workspace", "Remove sample data", "Open Inbox".

### 4.5 Tests

Pure helpers extracted to `src/modules/home/home-stats.js`: `computeHomeStats({ courses, students, assignments, submissions, videos, metadata, quota, now })` returning checklist completion booleans and attention items; test with fixtures (no DOM). Test `demo.js` load → `hasDemoData()` true → `removeDemoData()` → every table free of `is_demo` rows and demo submissions.

### 4.6 Smoke test

Fresh profile: Home shows checklist with 0/5; load sample data from About; Home shows "Sample" chips; remove sample data; checklist back to 0/5. Dark mode and projector theme on both pages.

---

## 5. Phase 2 — Classes, roster import, and class configuration

**Goal:** a teacher can set up a class in under five minutes from a SIS export or a pasted list, with access codes, and manage the roster from one place.

### 5.1 Files

Create: `src/components/class-setup-wizard.js`, `src/components/roster-import-dialog.js`, `src/core/roster-import.js` (pure parsing/mapping/merge logic), `src/core/oneroster.js`, `src/modules/gradebook/roster-view.js`, `tests/phase13-roster.test.js`.
Modify: `src/components/class-manager.js`, `src/modules/gradebook/index.js`, `src/modules/gradebook/course-settings.js`, `src/core/validator.js`, `src/modules/guide/index.js`, `sw.js` (v8).

### 5.2 Roster import engine (`src/core/roster-import.js`, pure)

```js
export function detectColumns(fields) → { mapping: { student_id, full_name, given_name, family_name, email, access_code, notes }, confidence }
// uses ROSTER_HEADER_ALIASES (Appendix A) with case/space/underscore-insensitive matching

export function normalizeRows(rows, mapping) → Array<RosterRowSchema-valid objects | { rowNumber, errors }>
// trims, joins/splits names via names.js, uppercases nothing (student IDs keep case but are compared case-insensitively)

export function planMerge(existingStudents, incomingRows, { updateExisting = true }) → {
  add: [], update: [{ existing, changes }], unchanged: [], conflicts: [{ row, reason }], duplicatesInFile: []
}
// key: trim(student_id).toUpperCase(); never overwrites an existing access_code unless the file column is explicitly mapped and the row has a value; email/name updates listed as changes

export function parsePastedRoster(text) → { fields, rows }
// accepts TSV (spreadsheet paste), CSV, or "one per line: Name <email>" / "Name, ID" lines
```

`src/core/oneroster.js`: `parseOneRosterBundle({ usersCsv, classesCsv, enrollmentsCsv, orgsCsv? })` → `{ classes: [{ sourcedId, title, classCode, schoolYear, students: [{ student_id, given_name, family_name, email, sourced_id }] }] }`. Mapping: `student_id = users.identifier || users.sourcedId`; students = enrollments with `role === 'student'`; `email = users.email`. Accept a `.zip` containing those files (JSZip is already in the import map).

### 5.3 Roster import dialog (`RosterImportDialog.open({ course, onDone })`)

Three tabs/sources: **Upload file** (`.csv`, `.tsv`, `.txt`, `.zip` for OneRoster), **Paste** (textarea, live preview), **OneRoster** (explains the three files; drop zone). Steps inside the dialog:

1. Parse → show detected delimiter and first 5 rows.
2. **Map columns**: one `sl-select` per target field with auto-detected choice; required: Student ID and at least one name field. Toggle "First row is a header".
3. **Preview merge**: counts for add/update/unchanged/conflicts; expandable lists; checkbox "Update names and emails of existing students" (default on); checkbox "Set access codes from file" shown only if a code column is mapped.
4. **Import** → single Dexie transaction → toast with counts → `onDone()`.
5. Offer "Generate access codes for new students now" (calls `AccessCodes.ensureForCourse`) and "Print code slips".

Replace the hidden `<input type="file" id="input-roster-csv">` flow in `gradebook/index.js` with this dialog. Keep the menu item label "Import roster…".

### 5.4 Class setup wizard (`ClassSetupWizard.open({ onDone })`)

A four-step `sl-dialog` (steps rendered one at a time, progress indicator, Back/Next):

1. **Class** — name, section/period, academic year (prefilled by `defaultAcademicYear()`), colour.
2. **Students** — embed the roster import dialog's source/mapping panel, or "Add later".
3. **Grading** — radio templates: *Points, two categories (Assessments 60 / Classwork 40)* [default, current behaviour], *Points, single category*, *Standards-based (4-level scale)*, *Copy structure from…* (select an existing class: copies categories, terms, letter scale, SBG config, standards, rubrics). Link: "Fine-tune later in Class settings".
4. **Access codes** — "Generate codes for everyone now" (default on) with Print slips / Export CSV buttons after creation, and a one-paragraph explanation of what codes do.

Finish screen: links to Gradebook, "Create your first assignment", "Share a video". Entry points: Class Manager "New Class" (replace the plain editor for *new* classes; keep the editor for edits), Home checklist and empty states, Gradebook Actions → "New class…". `ClassManager.saveClass` must accept an optional `template` object instead of always injecting defaults.

### 5.5 Roster view inside the Gradebook (`#/gradebook?view=roster`)

Add a third view mode next to Grades/Standards. `roster-view.js` renders a table: Name (sortable by family name), Student ID, Email, Access code (••••, Show/Copy/New), Hand-ins (count of latest `assignment_submissions` for assignments linked to this course + video receipts recorded in `gradebook_grades[].receipt`), Last hand-in, Current grade/letter, row menu (Profile drawer, Grade report link, Remove). Toolbar: Add student, Import roster…, Export roster CSV (`csv.js`; columns in Appendix A), Print code slips, bulk select → Generate codes / Remove. Persist the chosen view in `store` like `gradebookViewMode`.

### 5.6 Class Manager improvements

- List shows students count, assignments count, archived state; actions: Open gradebook, Roster, Settings, Archive/Unarchive, Delete (cascade from Phase 0).
- "Clone for next year" action: copies structure (not students) with `academic_year` advanced by one and `name` unchanged; "Clone section" keeps the year (existing clone behaviour moved here from the Gradebook menu, which keeps a shortcut).

### 5.7 Student profile drawer additions

Given/family name fields; email validation; "Appears in N classes" (same student ID in other courses) with links; submissions list for this class.

### 5.8 Tests (`tests/phase13-roster.test.js`)

`detectColumns` on headers in English/Dutch (`Naam`, `Leerlingnummer`, `E-mail`), Canvas export headers (`Student, ID, SIS User ID, SIS Login ID, Section`), Google Classroom (`Last Name, First Name, Email`); `planMerge` add/update/conflict/duplicate cases; `parsePastedRoster` TSV and `Name <email>`; `parseOneRosterBundle` with a 3-file fixture; wizard template application (pure helper `applyGradingTemplate(course, templateKey, sourceCourse?)`).

### 5.9 Smoke test

Run the wizard with a pasted TSV from a spreadsheet; verify codes generated; open Roster view; re-import with one changed email → one update; archive the class and confirm it leaves the header dropdown.

---

## 6. Phase 3 — Collecting student work

**Goal:** one Inbox for everything students hand back, clearer student-side hand-in, and a clean student mode.

### 6.1 Files

Create: `src/modules/inbox/index.js`, `src/core/envelope-router.js` (pure classification), `src/modules/assignments/import.js` (extracted import logic), `src/modules/video/receipt-import.js` (extracted from gradebook), `src/components/handin-instructions.js`, `tests/phase14-inbox.test.js`.
Modify: `src/modules/assignments/submissions.js`, `src/modules/assignments/take.js`, `src/modules/assignments/publish.js`, `src/modules/gradebook/index.js`, `src/modules/video/share-video.js`, `src/router.js`, `src/main.js`, `index.html`, `css/app.css`, `sw.js` (v9).

### 6.2 Envelope classification (`src/core/envelope-router.js`, pure)

```js
export function classifyText(text) → { kind: 'assignment'|'video_receipt'|'legacy_receipt'|'kbshare'|'unknown', assignment_id?, assessment_id?, publish_version?, text }
// KBSUB1./JSON envelope → SubmissionCrypto.parseEnvelope → header.kind === 'video-receipt' ? video : header.assignment_id ? assignment : unknown
// JSON with { receipt, signature } → legacy_receipt ; JSON with { d } → kbshare (a lesson, not work: tell the user)

export async function expandFiles(files) → Array<{ source: string, text: string }>
// .zip (JSZip) recursively; keep .kbsub/.kbr/.txt/.json; skip __MACOSX and hidden files; LMS bulk-download names like "lastfirst_12345_678_quiz3.kbsub" are preserved in `source`
// each text is split with splitSubmissionText (several codes pasted in one file)
```

### 6.3 Extract reusable importers

- `src/modules/assignments/import.js`: `importSubmissionTexts({ assignment, texts, roster, keys })` → `{ added, duplicates, errors, rows }`, moved verbatim from `submissions.js` `importTexts` minus DOM/toasts (the page calls it and renders).
- `src/modules/video/receipt-import.js`: `importVideoReceipts({ texts, course, students, assignments, gradesMap, mode: 'auto'|columnId, allowLegacy })` → `{ imported, createdColumns, problems }`, moved from `gradebook/index.js` lines ~617–736. Gradebook keeps its menu item but calls this function.

### 6.4 Inbox page (`#/inbox`)

Layout: large drop zone ("Drop .kbsub, .kbr, .txt or .zip files, or paste codes"), file picker, paste textarea, "Check server" button (Phase 6, hidden otherwise). After staging, a table: Source, Detected (assignment title or video title, publish version, student ID claimed from header when present — assignment envelopes have none in the header, so show "—" until decrypted), Status (new / duplicate / needs attention / error with reason from `DECRYPT_ERRORS`/`RECEIPT_ERROR_TEXT`). Buttons: Import all, Clear. After import: summary cards per target with "Review" links (`#/assignments/submissions?id=` or `#/gradebook`). Keep a session-only staging list (no persistence).

Also accept drops on the Home page and Assignments library (global `dragover`/`drop` listener in `main.js` that navigates to `#/inbox` and hands over the files via `store.setState('inboxDrop', files)`).

### 6.5 Student-side hand-in improvements (`take.js` results screen)

- Keep Download and Copy. Add **Share…** when `navigator.canShare?.({ files: [file] })` is true (mobile: send to Drive/Mail/Classroom).
- Add **Email to teacher** when the payload carries `handin.email` (publish option, see 6.6): opens `mailto:` with subject `[{title}] {student name} {student id}` and the instruction to attach the downloaded file (the code is too long for a reliable mail body; do not put it in `body`).
- Add **Hand in now** when the payload carries `relay` (Phase 6).
- Pre-fill Student ID and name from `store.getState('shareParams')` (`sid`, `sname`) set by the router when the share URL contained them; mark the ID field read-only when `sid` is present with an "Not you? change" link.
- Receipt screen shows the receipt code and the three hand-in steps in a numbered list.

### 6.6 Publish dialog additions (`publish.js`)

- **Hand-in instructions** block (`HandinInstructions.render({ assignment, link, dueDate, teacherEmail })`) with a Copy button, template in Appendix D. Teacher email comes from `app_metadata.teacher_profile.email` (editable inline here; stored).
- Option "Include my email as a hand-in method" → `payload.handin = { email }`.
- "Per-student links (CSV)" button → generates a CSV with `Email, FirstName, LastName, FullName, StudentID, Link` where each link is the same published link plus `&sid=<id>&sname=<url-encoded name>`; uses `LinkBuilder.withParams(url, { sid, sname })` (Phase 4 exposes this in the Return-feedback dialog too).
- Same additions in `share-video.js` (`sid`/`sname` prefill in the kiosk start form).

### 6.7 Router changes

- `_handleShareRoute(params)`: before activating, `store.setState('shareParams', { sid: params.sid || null, sname: params.sname || null })`.
- `_activateSharedPayload`: set/unset `document.body.dataset.mode` (§2.4); for `assignment` payloads keep existing navigation.
- `handleRoute`: clear `data-mode` when navigating to any route that is not student-facing.

### 6.8 Submissions page

- "Import" buttons now delegate to `import.js`; add "Open Inbox" link.
- Add **Not submitted** filter and "Export not-submitted list (CSV)" (columns `Email, FirstName, LastName, FullName, StudentID, Assignment, DueDate, Link`) for reminder mail merges.
- Show a "Collected N / roster M" progress bar in the header.

### 6.9 Tests (`tests/phase14-inbox.test.js`)

`classifyText` for each envelope kind (build real envelopes with `createSubmission` and `createSecureReceipt`); `expandFiles` with an in-memory zip containing nested folders and a `__MACOSX` entry; `importSubmissionTexts` duplicate/`is_latest` behaviour (moved tests from the UI path); router `shareParams` extraction (pure helper `extractShareParams(params)`).

### 6.10 Smoke test

Publish an assignment, take it in a private window with a `sid` link, download the file, zip it, drop the zip on Home → Inbox routes it, review, sync. Verify the private window shows student mode chrome only.

---

## 7. Phase 4 — Returning feedback: CSV exports, feedback links, mail merge

**Goal:** after grading, a teacher can return feedback in one of five ways from a single "Return feedback" dialog, and every export is mail-merge ready.

### 7.1 Files

Create: `src/components/export-dialog.js`, `src/core/export-presets.js` (column definitions, Appendix B), `src/modules/assignments/feedback-link.js` (payload builder), `src/modules/assignments/feedback-view.js` (student page), `src/modules/assignments/feedback-pdf.js`, `tests/phase15-feedback-exports.test.js`.
Modify: `src/modules/assignments/submissions.js`, `src/router.js`, `src/main.js`, `src/core/links.js`, `src/modules/guide/index.js`, `sw.js` (v10).

### 7.2 Export dialog component (`ExportDialog.open({ title, presets, rows, context })`)

Generic: preset selector (radio list with descriptions), options (delimiter `,`/`;` with `suggestDelimiter()` default, decimal `.`/`,`, include access codes (off; shows warning "Codes are secrets. Only include them if this file will be stored securely."), include per-question columns), live row count, preview of the first 3 rows, "Download CSV", "Copy as table" (TSV to clipboard for pasting into Google Sheets), and a short "Mail merge tips" expander (Appendix D). Shows a PII notice: "This file contains student names and emails. Store it where other student records are kept."

### 7.3 Assignment feedback link (new share type `assignment_feedback`)

`feedback-link.js: buildFeedbackPayload({ assignment, submission, student, course })` → payload (Appendix C). Encrypt with `AccessCodes.reportPassphrase(student)` (access code when set, else student ID with the same weak-link warning used by grade reports) through `LinkBuilder.feedback(...)` which calls `CryptoShareEngine.createSharePayload('assignment_feedback', payload, pass)`. Correct answers and explanations are included only when `assignment.settings.show_correct_answers` is on. Router: `type === 'assignment_feedback'` → `#/feedback`; `feedback-view.js` renders read-only (prompt via `renderSTEMMarkdown`, student answer text, points, per-question comment, overall comment, score, late/identity notes). Student mode chrome applies.

### 7.4 "Return feedback" dialog on the Submissions page

Replaces nothing; a new primary button next to "Sync to gradebook". Options:

1. **Mail-merge CSV** — one row per student on the roster (submitted or not), columns per Appendix B.2, `Link` = feedback link (generated per student; progress bar; PBKDF2 at 100k iterations takes ~0.1–0.3 s per link). `AssignmentLink` = published link with `sid`.
2. **Submissions CSV** — one row per latest submission with scores, per-question points/feedback (optional), identity, timestamps (Appendix B.1).
3. **Copy feedback for LMS comments** — dialog listing each student with a "Copy" button that copies `feedbackSummary(sub)` plus the feedback link; a "Copy all as table" button (StudentID ⇥ Name ⇥ Text).
4. **Feedback PDFs (ZIP)** — `feedback-pdf.js` renders one PDF per submission (jsPDF, same style as the grade report): header, score, per-question answer/key/comment, overall comment; ZIP via JSZip; filename `{student_id}_{assignment}.pdf`.
5. **Not submitted list (CSV)** — from Phase 3.

All five use `export-presets.js`; CSV writing is only `csv.toCSV`.

### 7.5 Gradebook feedback consistency

`syncToGradebook` already writes `feedbackSummary` into the grade's `feedback`. Add `feedback_link: url` to the grade's `extra` so the student's **grade report** (Phase 5) can include a "View your answers" link per assignment (the report page renders it as a button when present).

### 7.6 Tests (`tests/phase15-feedback-exports.test.js`)

`buildFeedbackPayload` strips correct answers unless allowed; round-trip encrypt/decrypt with access code; preset column order and header names match Appendix B exactly (snapshot test); `feedbackSummary` unchanged; "Copy as table" TSV has no CRLF inside cells.

### 7.7 Smoke test

Grade two submissions, open Return feedback → Mail-merge CSV with `;` delimiter, open in LibreOffice/Excel; open a feedback link in a private window with the access code.

---

## 8. Phase 5 — Gradebook CSV export and import with encoded report links

**Goal:** the whole gradebook can be exported for mail merge, SIS upload, or Excel editing, and scores can be imported back.

### 8.1 Files

Create: `src/modules/gradebook/gradebook-csv.js` (pure builders/parsers), `src/components/grades-import-dialog.js`, `tests/phase16-gradebook-csv.test.js`.
Modify: `src/modules/gradebook/index.js` (Actions menu), `src/modules/gradebook/report-generator.js`, `src/modules/gradebook/student-report.js`, `src/core/export-presets.js`, `src/core/links.js`, `sw.js` (v11).

### 8.2 Export presets (Appendix B.3–B.5)

Gradebook → Actions → **Export…** opens `ExportDialog` with:

1. **Mail-merge CSV with report links** — one row per student: `Email, FirstName, LastName, FullName, StudentID, Class, Section, Grade, Letter, Mastery, MissingCount, MissingList, LateCount, ReportLink` (+ optional per-assignment columns, + optional `AccessCode`). `ReportLink` from `GradebookReportGenerator.createStudentShareLink` per student (progress bar; cancellable). Option **Compact report** (drops rubric descriptors and standards evidence) to shorten links; show the longest link length and warn above 8,000 characters that some mail clients truncate; recommend the Phase 6 short links when available.
2. **Grades (wide, round-trippable)** — `StudentID, FullName, Email, <one column per assignment: "Title [max]">, Overall, Letter, Missing, Late`. Cells use the grid entry grammar from `parseCellEntry` in `virtual-grid.js`: score, `M`, `E`, `85L2` (late with days), blank for no record. Proficiency assignments export the level number.
3. **Canvas gradebook format** — `Student, ID, SIS User ID, SIS Login ID, Section, <"Title (id)">…`, second row `Points Possible`. Export only.
4. **OneRoster results** — `results.csv` + `lineItems.csv` per the 1.1 CSV spec (`sourcedId, status, dateLastModified, lineItemSourcedId, studentSourcedId, scoreStatus, score, scoreDate, comment`), using `sis.sourced_id` when present, else KB IDs. Export only.
5. **Roster CSV** — same as Phase 2 roster export (for convenience).

### 8.3 Grades import (`Actions → Import scores from CSV…`)

`gradebook-csv.js: parseGradesCSV(text) → { students: [{ student_id, cells: { header: value } }], headers }` and `planGradesImport({ parsed, course, students, assignments, gradesMap })` → `{ matchedColumns: [{ header, assignment }], unmatchedColumns, unknownStudents, changes: [{ student_id, assignment_id, before, after }] }`. Column matching: exact title, or `Title [max]`, or `Title (id)`. Cell parsing via `parseCellEntry`. Dialog shows the plan (changed cells count, unknown students/columns) and applies in one transaction, pushing each change onto the grid's undo stack (`virtualGrid.pushUndo`) so a mistaken import is one Ctrl+Z away.

### 8.4 Student report page addition

`student-report.js`: when an assignment entry has `feedback_link`, render "View your answers and comments" (opens the feedback link in the same tab; it will prompt for the access code again, which is acceptable).

### 8.5 Tests

Wide export → import round trip yields zero changes; `85L2` and `M`/`E` survive; Canvas header shape; OneRoster column set; mail-merge preset includes `ReportLink` for every student and `AccessCode` only when opted in; link length warning threshold.

### 8.6 Smoke test

Export wide CSV, edit two cells in a spreadsheet, import, undo, redo.

---

## 9. Phase 6 — Sync-server readiness

**Goal:** keep the product fully usable offline and serverless while making a school-hosted server an additive option. This phase delivers the client abstraction, the change log, and a small reference relay server that a school can run in minutes. It does **not** deliver full multi-device replication, student accounts, or LTI; those are designed here so the code written now does not block them.

### 9.1 Architectural options considered

| Option | What the server does | Server sees student data? | Effort | Unlocks |
|---|---|---|---|---|
| **A. Encrypted relay ("drop box")** | Stores opaque blobs: hosted lesson payloads (short links) and student submissions (already ECIES-encrypted to the teacher key). Teacher fetches with a token. | No (zero-knowledge: payload key lives in the URL fragment; submissions are encrypted to the teacher). | Small (one file, SQLite) | Short links, automatic hand-in, inbox "Check server", mobile-friendly collection. |
| **B. Per-teacher state sync** | Stores the teacher's op-log (outbox) so several devices converge. Can be zero-knowledge (client-side encryption with a passphrase) or school-trusted plaintext. | Only if the school chooses plaintext. | Medium | Multi-device, backup in the cloud, co-teachers (with ACLs). |
| **C. School LMS server** | Accounts (OIDC via school IdP), rostering (OneRoster/Clever/Classroom), student portal, live inbox, LTI 1.3 tool, admin reports. | Yes (school-run, under the school's DPA). | Large | "Real-time LMS", rostering automation, grade passback. |

**Decision:** build **A now** (this phase), design the client so **B** is a transport implementation, and treat **C** as a later server project that reuses A's API and B's op-log. The same `SyncTransport` interface serves all three.

### 9.2 Client contracts

`src/core/transport.js`:

```js
export class SyncTransport {
  static kind = 'null';
  async init(config) {}                       // { baseUrl, token, teacherId }
  get capabilities() { return { hostPayload: false, collectSubmissions: false, pushChanges: false, pullChanges: false, roster: false }; }
  async health() {}                           // → { ok, serverVersion }
  // Hosted lessons / links
  async publishPayload({ kind, ciphertext, expiresAt, meta }) {}   // → { ref }
  async fetchPayload(ref) {}                   // → { ciphertext, kind }
  // Hand-in
  async createDrop({ assignmentId, publishVersion, expiresAt }) {} // → { dropId }
  async submitToDrop(dropId, envelopeText) {}  // student side, no auth → { receiptId }
  async listDrop(dropId, { since }) {}         // teacher → { items: [{ id, received_at, text }] }
  // State sync (B; interface only in this phase)
  async pushChanges(ops) {}                    // outbox rows → { acceptedSeq }
  async pullChanges({ sinceServerSeq }) {}     // → { ops, serverSeq }
}
export class NullTransport extends SyncTransport {}
export class RelayTransport extends SyncTransport { /* fetch() against /api/v1 */ }
export async function getTransport() // reads app_metadata.sync_config or window.KB_CONFIG; caches instance; emits 'kb-transport-changed'
```

Config precedence: `window.KB_CONFIG` (optional `config.js` served next to `index.html`; add `config.example.js` and load it with `<script src="config.js" onerror="void 0">` before `main.js`) → `app_metadata.sync_config` → `NullTransport`.

### 9.3 Outbox (change log)

- Enable outbox writes in the Phase 0 wrapper: every `put`/`bulkPut`/`delete`/`bulkDelete`/`clear` on a data table appends `{ table, key, op, record?: (op === 'put' ? record : undefined), created_at, pushed_at: null, device_id }` inside the same transaction. Deletes carry the key only (server keeps tombstones; the client never needs tombstone fields).
- `storage.outbox.since(seq, limit)`, `storage.outbox.markPushed(seqs)`, `storage.outbox.prune(olderThanDays = 30, onlyPushed = true)`.
- Convert the collection-level deletes listed in §2.2 to key-based deletes.
- Merge rules to document in code comments for the future B implementation: last-writer-wins on `updated_at` with `device_id` tiebreak per record; `gradebook_grades` is per-cell so LWW is natural; `assignment_submissions` are append-only (never conflict); course settings are whole-record LWW.

### 9.4 Hosted links (short links)

- `CryptoShareEngine.wrapForHosting(rawFileContent)` → `{ ciphertext (base64url of AES-GCM over the rawFileContent JSON with a random 256-bit key), key (base64url) }` and `unwrapHosted(ciphertext, key)`.
- `LinkBuilder.hosted(ref, key)` → `${origin}${pathname}#/share?ref=${ref}&k=${key}`. The key is in the fragment and is never sent to the server.
- Router `_handleShareRoute`: if `params.ref` → `transport.fetchPayload(ref)` → `unwrapHosted` → continue with the existing `{ enc, d }` logic (passphrase protection still works on top).
- Share/publish dialogs show a "Short link" toggle when `capabilities.hostPayload`; default on when available. Expiry default: 180 days.

### 9.5 Server-assisted hand-in

- On publish with a relay: `createDrop` → `payload.relay = { base_url, drop_id }`. `take.js` results: "Hand in now" → `submitToDrop`; on success show the server receipt ID and keep the download as a fallback.
- Inbox "Check server": `listDrop` for every published assignment with `relay.drop_id`, since the last `app_metadata.relay_cursor[drop_id]`; feed texts into the Phase 3 importer.
- Video share dialog: same, using the assessment ID.

### 9.6 Reference relay server (`server/relay/`)

Files: `server/relay/index.js` (HTTP, routing, CORS, limits), `server/relay/db.js` (`node:sqlite`), `server/relay/auth.js` (bearer tokens), `server/relay/README.md`, `scripts/relay-add-teacher.mjs`. Add scripts: `"relay": "node server/relay/index.js"`, `"relay:add-teacher": "node scripts/relay-add-teacher.mjs"`. No npm dependencies.

API (`/api/v1`, JSON, CORS allow-list from env `KB_RELAY_ORIGINS`):

| Method | Path | Auth | Body / Query | Response |
|---|---|---|---|---|
| GET | `/health` | none | — | `{ ok, version }` |
| POST | `/payloads` | teacher | `{ kind, ciphertext, expires_at, meta: { title } }` ≤ 512 KB | `{ ref }` (22-char base64url) |
| GET | `/payloads/:ref` | none | — | `{ kind, ciphertext }` or 404/410 |
| POST | `/drops` | teacher | `{ assignment_id, publish_version, expires_at }` | `{ drop_id }` |
| POST | `/drops/:dropId/submissions` | none; rate-limited per IP (e.g. 30/min); size ≤ 256 KB; must start with `KBSUB1.` | text/plain envelope | `{ receipt_id, received_at }` |
| GET | `/drops/:dropId/submissions?since=<iso>` | teacher (owner) | — | `{ items: [{ id, received_at, text }] }` |
| DELETE | `/drops/:dropId` | teacher (owner) | — | 204 |

Tables: `teachers(id, name, token_hash, created_at)`, `payloads(ref, teacher_id, kind, ciphertext, meta, created_at, expires_at)`, `drops(id, teacher_id, assignment_id, publish_version, created_at, expires_at)`, `submissions(id, drop_id, received_at, text)`. Expired rows are pruned hourly. Tokens are random 32-byte values shown once by the add-teacher script and stored as SHA-256.

Security notes to put in the README: the relay never sees plaintext lessons (fragment key) or submissions (ECIES to the teacher key); it does see metadata (titles if provided, timestamps, IPs); run behind HTTPS; set `KB_RELAY_ORIGINS`; backups of the SQLite file are safe to store since contents are ciphertext.

### 9.7 Client settings and status

- Storage/Help menu → "Connect to a school server…" dialog: base URL, token, Test connection, Save; stored in `app_metadata.sync_config`. Shows capabilities returned by `/health` (`{ features: ['payloads','drops'] }`).
- Add `<span id="sync-status-indicator">` to the header (fixes D-09); the indicator shows backup state (existing) and relay state ("Server: connected").

### 9.8 Service worker

Network-only for requests whose URL path starts with `/api/` or whose origin differs from `self.location.origin` and is not jsdelivr (D-14).

### 9.9 Later work (documented, not built)

- **B. State sync:** `RelayTransport.pushChanges/pullChanges` against `/sync/ops`; client applies remote ops through the wrapper with a `fromRemote` flag (no outbox echo); conflict rules from §9.3; optional client-side encryption of `record` with a passphrase-derived key (zero-knowledge mode) using the existing PBKDF2/AES-GCM primitives.
- **Rostering automation:** server-side OneRoster REST consumer / Clever / ClassLink / Google Classroom; pushes `gradebook_students` ops to the teacher's op-log with `sis.sourced_id`; the client's merge logic from Phase 2 (`planMerge`) is reused unchanged.
- **Student accounts:** OIDC via the school IdP for students; access codes remain the no-account fallback; the server can verify `accessCodeCheck` values without storing codes.
- **LTI 1.3 Advantage:** the server becomes the tool (OIDC launch, JWKS, Deep Linking to place an assignment link in the LMS, NRPS to pull the roster, AGS to pass back grades from the gradebook export preset in §8.2). Prerequisite: option B so the server holds the gradebook state.
- **Real-time:** Server-Sent Events on `/drops/:id/stream` for live inbox counts; no WebSocket needed.
- **Co-teaching:** class-level ACL tables; invitations by link.

### 9.10 Tests (`tests/phase17-transport.test.js`)

Outbox: a `put` and a `delete` through the wrapper produce two rows in one transaction; `since`/`markPushed`/`prune`. `wrapForHosting`/`unwrapHosted` round trip; tampering fails. `RelayTransport` against a mocked `fetch`. Server: spawn `server/relay/index.js` on a random port in a test (Node `child_process`) and exercise `/health`, `/payloads`, `/drops` with and without tokens, size limit, rate limit. SW fetch handler unit test for `/api/` bypass (extract the decision into a pure function in `sw.js`).

### 9.11 Smoke test

Run `npm run relay` with one teacher token; connect from the client; publish with short link; open the short link in a private window; hand in; Inbox → Check server imports it.

---

## 10. Verification matrix

| Phase | New test file | Key assertions | Manual check |
|---|---|---|---|
| 0 | `phase11-foundation` | v4 migration, wrapper stamping, RosterRowSchema, csv.js, names.js, cascade deletes | roster CSV import works; no demo auto-seed |
| 1 | `phase12-home-about` | `computeHomeStats`, demo load/remove | Home checklist and attention list; About page |
| 2 | `phase13-roster` | column detection, merge plan, OneRoster, pasted rosters, templates | wizard, roster view, archive |
| 3 | `phase14-inbox` | envelope classification, zip expansion, importer parity, share params | drop zip on Home; student mode |
| 4 | `phase15-feedback-exports` | feedback payload, presets snapshot, encryption | Return feedback dialog; feedback link |
| 5 | `phase16-gradebook-csv` | wide round trip, Canvas/OneRoster shapes, import plan | export/import/undo |
| 6 | `phase17-transport` | outbox, hosted wrap, relay API | relay end-to-end |

Run the full suite after every phase; the existing 94 tests must keep passing (the only intended behavioural change to existing tests is the roster schema; update `phase1-core` if it asserts the old alias map).

---

## Appendix A — Roster import: aliases and roster CSV columns

**`ROSTER_HEADER_ALIASES`** (normalise header by lower-casing and removing spaces, underscores, hyphens, dots before matching):

| Target | Accepted headers |
|---|---|
| `student_id` | `studentid`, `id`, `sisid`, `sisuserid`, `sisloginid`, `studentnumber`, `number`, `leerlingnummer`, `leerlingnr`, `stamnummer`, `identifier`, `sourcedid`, `username` |
| `full_name` | `studentname`, `fullname`, `name`, `student`, `naam`, `leerling` |
| `given_name` | `firstname`, `first`, `givenname`, `voornaam`, `roepnaam` |
| `family_name` | `lastname`, `last`, `surname`, `familyname`, `achternaam` |
| `email` | `email`, `emailaddress`, `mail`, `e-mail`, `studentemail` |
| `access_code` | `accesscode`, `code`, `toegangscode` |
| `notes` | `notes`, `note`, `comments`, `opmerkingen` |

Rows whose `student_id` is blank but `email` is present: offer "Use email as student ID" in the mapping step.

**Roster export columns:** `StudentID, FullName, FirstName, LastName, Email, Class, Section, AcademicYear, HasAccessCode, AccessCode (opt-in), Notes`.

## Appendix B — Export presets (exact headers, in order)

Headers are single words in PascalCase so Gmail (`@Header`), YAMM (`{{Header}}`), Word and Thunderbird merges all work without renaming.

**B.1 Submissions CSV (per assignment):** `StudentID, FullName, FirstName, LastName, Email, Assignment, Class, Status (Submitted|NotSubmitted), SubmittedAt, DaysLate, Identity, Score, MaxScore, Percent, PendingReview, Feedback` + optional per question `Q1Points, Q1Max, Q1Feedback, …`.

**B.2 Mail-merge CSV (per assignment):** `Email, FirstName, LastName, FullName, StudentID, Class, Assignment, DueDate, Status, Score, MaxScore, Percent, Feedback, Link, AssignmentLink` (+ `AccessCode` opt-in). `Link` is the encrypted feedback link; blank when not submitted. `AssignmentLink` includes `sid`/`sname` prefill.

**B.3 Gradebook mail-merge CSV:** `Email, FirstName, LastName, FullName, StudentID, Class, Section, Grade, Letter, Mastery, MissingCount, MissingList, LateCount, ReportLink` (+ per-assignment `A1Score…` opt-in, + `AccessCode` opt-in).

**B.4 Gradebook wide CSV:** `StudentID, FullName, Email, <Title [max]>…, Overall, Letter, Missing, Late`.

**B.5 Canvas:** `Student, ID, SIS User ID, SIS Login ID, Section, <Title (id)>…` with a `Points Possible` second row.

**B.6 Not submitted:** `Email, FirstName, LastName, FullName, StudentID, Assignment, DueDate, Link`.

Formatting: `Percent` as a number (0–100, one decimal), dates as ISO `YYYY-MM-DD` and timestamps as ISO 8601 local time, booleans as `Yes`/`No`.

## Appendix C — `assignment_feedback` payload

```json
{
  "version": 1,
  "kind": "assignment_feedback",
  "generated_at": "ISO",
  "student": { "student_id": "S101", "full_name": "Emma Watson" },
  "course": { "name": "AP Chemistry", "section": "Period 2" },
  "assignment": { "title": "Quiz 3", "due_date": "2026-10-10", "total_points": 25 },
  "submission": { "submitted_at": "ISO", "days_late": 0, "identity": "verified", "publish_version": 2 },
  "score": { "earned": 21, "possible": 25, "pending": 0 },
  "overall_feedback": "…",
  "questions": [
    { "n": 1, "type": "single_choice", "prompt": "markdown", "student_answer": "text", "earned": 2, "possible": 2, "correct": true,
      "feedback": "…", "correct_answer": "text or null", "explanation": "markdown or null" }
  ]
}
```

`student_answer` is produced by the same formatter the review drawer uses (`formatAnswer` logic moved to `grading.js: answerToText(q, v)` so both sides share it).

## Appendix D — Hand-in instructions template and mail-merge recipes

**Hand-in instructions (copied into the LMS post):**

```
{title} — due {due date}
1. Open this link: {link}
2. Enter your full name, your student ID and the access code you received from me.
3. Answer the questions. Your answers save automatically in your browser.
4. When you finish, click "Download submission file" and upload the .kbsub file here{email ? " or email it to {email}" : ""}.
   If you cannot upload files, click "Copy submission code" and paste the code as a comment.
Nothing is sent automatically. Your work is encrypted so only I can open it.
```

**Mail-merge recipes (shown in the export dialog and the guide):**
- *Gmail + Google Sheets (built-in mail merge):* import the CSV into a Sheet, in Gmail choose "Mail merge", pick the Sheet, write `@FirstName` and paste `@Link`.
- *Gmail + YAMM / Outlook + Word:* same columns; placeholders `{{FirstName}}` (YAMM) or `«FirstName»` (Word). In Word, insert the link as a HYPERLINK field so long URLs are not wrapped.
- *Thunderbird Mail Merge add-on:* `{{FirstName}}`.
- Keep links on their own line; do not shorten them with third-party services (that would hand the encrypted payload to another company). Prefer the school relay's short links when available.
- Access codes should reach students by a different channel than the link (printed slips, in person). The `AccessCode` column is off by default for that reason.

## Appendix E — Teacher guide updates

Add sections: "Set up a class" (wizard + roster import sources + OneRoster), "Collect work: the Inbox", "Return feedback" (five options), "Export your gradebook" (presets, mail merge, Canvas/OneRoster), "Connect to a school server" (what changes, what stays private). Rename references: "Import Roster CSV…" → "Import roster…"; add "Roster" view; add About page link. Replace the troubleshooting entry "The link is very long" with the short-link note.

## Appendix F — Files touched per phase (checklist for `sw.js`)

- Phase 0: `src/core/csv.js`, `src/core/names.js`, `src/core/academic-year.js`, `src/core/demo.js`
- Phase 1: `src/modules/about/index.js`, `src/modules/home/home-stats.js`, `src/components/setup-checklist.js`, `src/version.js`
- Phase 2: `src/components/class-setup-wizard.js`, `src/components/roster-import-dialog.js`, `src/core/roster-import.js`, `src/core/oneroster.js`, `src/modules/gradebook/roster-view.js`
- Phase 3: `src/modules/inbox/index.js`, `src/core/envelope-router.js`, `src/modules/assignments/import.js`, `src/modules/video/receipt-import.js`, `src/components/handin-instructions.js`
- Phase 4: `src/components/export-dialog.js`, `src/core/export-presets.js`, `src/modules/assignments/feedback-link.js`, `src/modules/assignments/feedback-view.js`, `src/modules/assignments/feedback-pdf.js`
- Phase 5: `src/modules/gradebook/gradebook-csv.js`, `src/components/grades-import-dialog.js`
- Phase 6: `src/core/transport.js`, `config.example.js` (not cached), `server/relay/*` (not cached)
