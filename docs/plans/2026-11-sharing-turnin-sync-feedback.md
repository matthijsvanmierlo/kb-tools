# KennisBoost Tools: Fix Plan for Publishing, Turn-in, Relay Ingest, Sync and Feedback

> On approval, save this document to `docs/plans/2026-11-sharing-turnin-sync-feedback.md`, then commit it on a new branch. Another agent (or a follow-up session) will carry out the work, one recommendation per PR, in the order below.

## Context

KennisBoost Tools is a local-first PWA LMS with an optional relay server. The relay has two backends: Node/SQLite in `server/relay/db.js` and Cloudflare D1 in `server/relay/d1-db.js`, both behind the same `server/relay/handler.js`. Teachers author two kinds of work, and the module names don't match the UI labels:

| Module | Shown in the UI as |
|---|---|
| `src/modules/assignments/` | Assessments |
| `src/modules/tasks/` | Assignments |

Work is published as share links, as a course feed, or through relay "drop boxes". Students hand in through the relay or by moving files by hand (.kbsub, .html, QR, code). Feedback comes back as links, files, or a relay "feedback drop".

An audit of the code (every finding below was checked against the source) found that **the main paths quietly lose student work or give a false picture of what happened**:
- Teachers' publish details get overwritten, so they read drop boxes nobody posts to.
- Students are told "Handed in" when nothing was sent.
- Relay pulls skip or block submissions.
- Cross-device sync can drop edits.
- Feedback sent through the relay is never fetched.

Recent commits ("relay fixes etc.", "fixed sharing hopefully") show these are the areas causing ongoing pain.

**Goal:** five fixes, one per area, so that what the app shows matches what actually happened, and student work is never silently lost.

## Recommendations (ranked)

| # | Recommendation | Severity | Main area |
|---|---|---|---|
| R1 | One publish path and a stable drop box for each item | Critical: lost submissions | Teacher creation and sharing |
| R2 | Honest, reliable student turn-in (relay and non-relay) | Critical: false "handed in" | Student completion and turn-in |
| R3 | Lossless relay ingest (teacher pulls, server endpoints, join errors) | High: skipped or blocked submissions | Relay server behavior |
| R4 | Replication data safety (outbox, gaps, cursor, chunk size) | High: silent sync loss | Syncing |
| R5 | Feedback return and notifications (teacher and student) | High: feedback never arrives, badges wrong | Feedback and notifications |

**Dependencies:**
- R1 comes first, because R3 and R5 depend on `publish.relay` being reliable.
- R2 and R4 don't depend on anything else and can run in parallel with R1, since they touch different files.
- R3 comes after R1. R5 comes after R2 and R3.

---

## Ground rules for the executing agent

- **Run tests:** `npm test` (vitest with jsdom and fake-indexeddb). Add new suites as `tests/phase45-*.test.js` and up, one or more per recommendation.
- **Rules enforced by existing tests:**
  - Use `generateUUID` from `src/utils/uuid.js`, never `crypto.randomUUID` directly (`tests/no-direct-random-uuid.test.js`).
  - Use `ConfirmDialog`/`PromptDialog` from `src/utils/dialogs.js`, never `alert`/`confirm`/`prompt` (`tests/no-native-dialogs.test.js`).
- **Match the existing style:** vanilla ES modules, Shoelace `sl-*` components, Tailwind classes, the `toast` from `src/utils/toast.js`, and the `storage.table(...)` and `storage.getMetadata/setMetadata` helpers from `src/core/storage.js`.
- **Server changes:**
  - Every change to `db.js` needs the same change in `d1-db.js`.
  - Bump `SCHEMA_VERSION` in `server/relay/limits.js` only if a column or index is added.
  - D1 needs a real `ALTER` migration, because `initSchema` in `d1-db.js:26` currently returns early when the version matches.
- After any change to files in `sw-assets.js`, run `npm run build:sw`.

---

## R0: Hotfixes (do first, inside the R2 PR, or as their own tiny PR)

These are one-line crashes or no-ops. Each is small but blocks testing everything else.

1. **`toast.error` doesn't exist.**
   - `src/utils/toast.js:71-87` defines `success/warning/danger/info/action` but not `error`. About 15 call sites use it: `tasks/take.js:679,848,1179,1213,1246`, `tasks/review.js:814,855`, `tasks/submissions.js:536,808,811`, `tasks/publish.js:167,319`, `components/export-dialog.js:338`, `components/grades-import-dialog.js:196,206,259`.
   - Each one throws inside a `catch`, so the user sees nothing.
   - **Fix:** add `static error(msg, duration) { return this.danger(msg, duration); }`.
   - **Test:** fail if any `toast.<method>` call in `src/` uses a method `Toast` doesn't define.
2. **Task access-code check is a no-op.** In `tasks/take.js:369-370`, `if (!ok)` never fails because `checkTaskAccessCode` (`tasks/pipeline.js:13-19`) returns `'ok'|'mismatch'|'unknown_student'|'not_checked'`, and every one is truthy.
   - **Fix:** block on `'mismatch'`, and show "ID not on roster" for `'unknown_student'`, matching how the assessments module handles it in `assignments/take.js`.
3. **Back button ReferenceError.** `assignments/editor.js:762` and `tasks/editor.js:312` read `params`, which isn't defined in `renderEditor(assignment, router, container)` / `renderTaskEditor(task, router, container)`.
   - **Fix:** add a fourth argument `params = {}`, and pass `params` from the callers `assignments/index.js:45` and `tasks/index.js:136`.

---

## R1: One publish path and a stable drop box for each item

### Problems (evidence)

1. **The task editor undoes its own publish.**
   - `tasks/editor.js:329-335` calls `save(true)` in `onPublished`.
   - `save` (`:86-97`) writes the editor's local copy `t`, but `publishTask` (`tasks/publish.js:61-72,149`) stored a new object `next`.
   - Result: `publish` (including `relay.drop_id`) reverts to its old value, often `null`.
   - The assessments dialog avoids this with `Object.assign`.
2. **Publishing from the Course page wipes the relay details.** `course/render.js:512-516, 522-526, 563-567, 573-577, 613-617, 623-627` replace `publish` with `{version, salt, published_at}`, dropping `relay`, `fingerprint` and `roster_hash`. The salt fallback `'asg-salt-'+id.slice(0,8)` is also predictable.
3. **Opening the assessment publish dialog republishes.**
   - It republishes on open (`assignments/publish.js:490-492`) and on every option change (`:288,290,305,313,317,320`).
   - Each republish creates a new drop box. Teachers only pull the latest one (`assignments/submissions.js:1299`, `inbox/index.js:340`).
   - Students using older links post to drop boxes nobody reads.
   - It also raises `publish.version`, which flags real work as `stale_version` (`assignments/pipeline.js:225`).
4. **Drafts leak into the student feed.**
   - `gradebook/bridge.js:248,338` sets `published: isPublished`, which is true for content that was never published.
   - `core/course-feed.js:63-66, 82-85` makes up a `publish` block for unpublished items.
   - `assignments/seed.js:9,23-24` recreates the deleted sample quiz, links it to the first class, and it lands in that class's feed.
5. **Assessments in the course feed have no hand-in.** `course-feed.js:76` passes `relay`, but `buildStudentPayload` (`assignments/grading.js:~453`) ignores it. Tasks forward it (`tasks/publish-core.js:82-89`).

### Fix steps

1. **Extract `src/core/publish-core.js`** with the code currently duplicated between `assignments/publish.js` and `tasks/publish.js`:
   - `computeRosterHash`
   - roster status
   - `randomSalt`
   - building roster checks and cards
   - `ensureDropBox(item, transport)`

   Have both modules import it and delete their copies.
2. **Make drop boxes stable.**
   - `ensureDropBox` reuses `item.publish.relay` when it exists, isn't expired, and belongs to the same relay `base_url`. It creates a new one only otherwise.
   - When it does create a new one, it appends the old `drop_id` to `publish.relay_history = [{drop_id, drop_secret, base_url, retired_at}]`, so R3's pull can drain old boxes.
3. **Split "publish" from "view link" in the assessments dialog.**
   - When `assignment.publish` exists, opening the dialog shows the stored link, rebuilt from the stored payload or ref. It must not republish.
   - Option changes mark the dialog "Unsaved changes – Update link" and republish only when that button is clicked.
   - Raise `publish.version` only when the student-visible content hash changes. Hash the output of `buildStudentPayload` minus `published_at` and compare it to `publish.content_hash`.
   - Make the same change in `tasks/publish.js:269`: add "Copy existing link".
4. **Fix the task editor overwrite.**
   - `openTaskPublishDialog` passes the published record to `onPublished(next)`.
   - In `tasks/editor.js`: `onPublished: (next) => { Object.assign(t, next); save(true); }`.
   - Belt and braces: in `save()`, re-read `publish` from storage and keep the newer `publish.published_at`, so a stale editor copy can never roll it back.
5. **Make the Course page call the real publish functions.** Replace the inline `publish = {...}` blocks in `course/render.js` (`publishSingleItem` and "Publish all drafts") with calls to `publishAssignment` (`assignments/publish.js:65`) and `publishTask` (`tasks/publish.js:52`). Those already run the validations: no questions; no submission type.
   - "Publish all drafts" must skip items that are already published and items that are hidden.
6. **Give `published` one meaning everywhere.**
   - In `bridge.js:248,338`, set `published = !!source.publish?.published_at`.
   - In `course-feed.js`, remove the synthesized `publish` blocks and leave out items whose source has no `publish`.
   - In `seed.js`, set metadata `sample_assignment_seeded=true` the first time and never re-seed after that. Never link the sample to a class automatically.
7. **Thread `relay` through `buildStudentPayload`** in `assignments/grading.js`, the same way `tasks/publish-core.js` does, so assessments delivered by the feed show "Hand in to teacher".
8. **Formative toggle:** in `assignments/publish.js:293-295`, don't delete the gradebook column if it already has grades. Ask with `ConfirmDialog` first.

### Tests (`tests/phase45-publish-integrity.test.js`)

- Task publish followed by the editor save keeps `publish.relay.drop_id`.
- Opening the assessment dialog twice leaves `publish.version` and `drop_id` unchanged.
- Republishing with new content keeps the `drop_id` when the drop box is still valid.
- Course-page publish keeps `publish.relay`.
- The feed leaves out a never-published task.
- Deleting the sample assessment followed by `ensureSampleAssignment()` doesn't recreate it.
- Clicking the editor Back button with `returnCourseId` navigates there without throwing.

### Acceptance

A teacher can publish, re-open the dialog, edit, and publish again from either the editor or the Course page, and a student holding any link the teacher gave out still reaches a drop box the teacher reads.

---

## R2: Honest, reliable student turn-in (relay and non-relay)

### Problems (evidence)

1. **Tasks claim "Work Handed In!" after a download.** `tasks/take.js:1186-1210` calls `recordSuccess` and shows the receipt screen after a .kbsub/.html download. Assessments correctly say "not sent automatically" (`assignments/take.js:942`).
2. **Every hand-in click re-encrypts with a new `submitted_at`** (`tasks/take.js:1155,1191`). Relay plus download gives the teacher two distinct submissions, and the server's hash dedup can't catch it.
3. **The assessment relay success isn't saved.**
   - The success state at `assignments/take.js:1017-1041` is never stored. `openSendSheet` is called without `onHandedIn` (`:1066`).
   - After a reload the "Hand in" banner comes back.
   - The ledger records "Submitted" at the Submit click (`:878`), before any hand-in.
4. **The task draft is never cleared after submit**, and there's no receipt check on load, which invites resubmitting.
5. **Inline base64 file fallbacks fill localStorage.** Files up to 4 MB fall back to inline base64 in the localStorage draft (`tasks/take.js:657-668`). The quota error is swallowed (`:30`), so every later autosave fails silently.
6. **Relay failure for tasks gives no next step** (made worse by R0.1). Assessments do say "use the file download below".

### Fix steps

1. **Add a shared hand-in state model.** Create `src/core/handin-state.js`, keyed `handin:<kind>:<itemId>:<studentId>:<publishVersion>`, and store it through the existing `safeStorage` / student storage:
   ```
   {
     envelope_text,
     submitted_at,
     status: 'prepared' | 'sent_relay' | 'downloaded' | 'shared',
     relay_receipt?,
     relay_received_at?,
     channel_history: []
   }
   ```
   - Encrypt the envelope **once** at submit. Every channel (relay, .kbsub, .html, QR, copy) reuses the same `envelope_text`, so the teacher's dedup on `student_id+submitted_at` collapses repeated sends.
2. **Make the student ledger say what happened.** Add `StudentLedger` statuses (`src/modules/student/ledger.js`):
   - `Ready to hand in`: the envelope exists but hasn't been sent.
   - `Handed in (server receipt …)`: sent through the relay.
   - `File saved – upload it to your teacher`: downloaded only.

   Write "Submitted" only for a confirmed relay hand-in. For non-relay channels, write "Saved for hand-in" plus the channel used.
3. **Tasks receipt screen** (`tasks/take.js:1265` `renderReceipt`): show different text for relay (receipt ID plus server time) and for file. The file version shows an amber "Not yet received – upload `<filename>` to your teacher (LMS/email)" with the hand-in instructions from `components/handin-instructions.js`.
4. **Persist assessment relay success:**
   - Write the receipt into hand-in state.
   - Pass `onHandedIn` to `openSendSheet`.
   - On render, read hand-in state and show "Handed in at HH:MM (receipt X)" with a disabled button.
5. **Relay failure falls back clearly** in both modules. Show a `danger` toast plus an inline panel with the error mapped to plain language. Do this in a new `transport.js` helper, `describeRelayError(err)`, keyed on HTTP status:

   | Status | Message |
   |---|---|
   | 413 | File too large |
   | 410 | Drop box closed |
   | 403 | Wrong link or secret |
   | 429 | Busy – retry in a minute |
   | network | Offline |

   Always show the download/QR buttons next to it, with a Retry button.
6. **Drafts:**
   - Clear the task draft (`safeStorage.remove`) after a confirmed hand-in.
   - On load, if hand-in state exists for the current `publish_version`, show "You already handed this in on …" with a "Hand in a new version" button.
   - Don't put inline base64 over 256 KB into the localStorage draft. Store it in IndexedDB (the existing `src/utils/student-media.js` / content-addressed blobs) and keep only a reference.
   - Show a warning toast once if the draft save hits a quota error, instead of swallowing it.
7. **Assessment drafts across devices:** `draft-roaming.js:106` returns `null` for submitted drafts. Return `{submitted:true, submitted_at}` instead, so another device shows "already handed in".

### Tests (`tests/phase46-turnin-honesty.test.js`)

- Task file download leaves the ledger as "File saved", not "Submitted", and the receipt copy says "not yet received".
- Relay then download produces the same `envelope_text`, and the teacher import of both gives one submission.
- A relay 413 shows the plain-language error and keeps the download button.
- After a reload, assessment hand-in state shows "Handed in".
- `checkTaskAccessCode` returning `'mismatch'` blocks the student.
- A quota error on the draft gives a warning.

### Acceptance

The student's screen and ledger always match what the teacher can actually receive. Repeated sends of one attempt never produce duplicates.

---

## R3: Lossless relay ingest (teacher pulls and server endpoints)

### Problems (evidence)

1. **Equal timestamps can skip submissions.** `submissions.list` uses `received_at > ?`, `LIMIT 100`, with no tiebreaker (`db.js:601-618`, `d1-db.js:618-636`). Two rows with the same `received_at` at a page boundary means one is skipped forever. Clients only ever fetch one page (`transport.js:238-252`, no `more`).
2. **Three independent pull loops with different bugs:**
   - Inbox (`inbox/index.js:335-363`) keeps its own `relay_cursors` and saves the cursor *before* import, though staged items live only in memory (`:21`). Per-drop errors only go to `console.warn`.
   - Assessments (`assignments/submissions.js:1290-1325`) advance past items that failed.
   - Tasks (`tasks/submissions.js:690-702`) `break` on the first bad item, so one junk post blocks all later ones.
3. **Task submissions aren't de-duplicated.** `recordTaskSubmission` (`tasks/submissions.js:35-63`) gives every import a new row, marks all earlier rows (graded ones included) as not latest, and doesn't order by `submitted_at`. The Inbox hardcodes `duplicates: 0` for tasks (`inbox/index.js:694`), and `kindLabel` has no `'task'` case, so tasks show as "Unknown" (`:775-792`).
4. **Resubmitting an assessment copies old grades.** `assignments/import.js:62-73` copies the old attempt's manual points and feedback onto the new answers.
5. **Server problems:**
   - **Expired feed:** `feeds.get` returns `{expired:true}` (`db.js:646`), but `handler.js:1362` only checks for null. The response is 200 with `ETag: "undefined"`, so students get stuck on 304s.
   - **Teacher media is deleted after about 24 h:** media GC step 12 (`db.js:226-240`, `d1-db.js:229-243`) deletes every `media_refs` row with no `drop_media` row, and teacher uploads (`handler.js:401-403`) never have one.
6. **Join errors are hidden.**
   - `transport.fetchCourseFeed` (`transport.js:566-568`) throws without a status.
   - `join-service.js:107` looks for `'404'` in the message, misses, and treats it as "offline". It then creates a permanent ghost class `course-pending-XXXX` (`:160-172`).
   - `router.js:861-866` shows nothing for `not_found`.

### Fix steps

1. **Server: a keyset cursor for drop submissions.**
   - Order by `received_at ASC, id ASC`. Accept `after=<received_at>|<id>`, with the condition `(received_at > ? OR (received_at = ? AND id > ?))`.
   - Return `{items, next_after, more}`. Keep `since` working for older clients.
   - Add the index `submissions(drop_id, received_at, id)` to `schema.sql`, `schema.js` and the D1 migration path.
2. **Client: one shared pull function.** Create `src/core/drop-pull.js` with `pullDrop({ transport, dropId, cursorKey, onItem })`:
   - Loops pages until `more` is false.
   - Calls `onItem` for each item.
   - Collects failures as `{id, error}` without stopping.
   - Advances the cursor to the last item processed, whether it succeeded or failed. Failed items go to the existing quarantine/error list in the UI so the teacher can see them and import them by hand.
   - Uses **one** cursor store, `metadata relay_cursors[dropId]`, shared by the Inbox and the per-item pulls.
   - Drains `publish.relay_history` (from R1) as well as the current drop box.
3. **Rewrite the three loops to use `pullDrop`.**
   - The Inbox persists staged items: store them in `metadata inbox_staged` (or a small table), and save the cursor only after staging is persisted.
   - "Clear list" asks for confirmation and warns that the items are only still available through each assignment's Pull.
   - Show failures in a toast summary such as "Imported 12, 2 couldn't be read (see details)".
4. **De-duplicate task submissions** in `recordTaskSubmission`:
   - Skip when a row already exists with the same `student_id` and `submitted_at`. With R2's single envelope this is enough.
   - Decide `is_latest` by the newest `submitted_at`, not by import order.
   - Never mark a graded row not-latest when the incoming row is older.
   - Return `{duplicate:true}` so the Inbox can count it. Add the `'task'` case to `kindLabel`/`kindBadgeClass`.
5. **Assessment resubmission:**
   - Stop copying `manual` and `feedback` onto the new attempt in `assignments/import.js`.
   - Keep `prior_attempt_id`.
   - In the grading UI (`assignments/submissions.js`), show "Previous attempt was graded – view / copy grades", which copies only when the teacher clicks it.
6. **Server fixes:**
   - **Expired feed:** in `handler.js` around 1362, return `410 {error:'Course feed expired'}`. Never emit `ETag` when `feed.etag` is falsy.
   - **Media GC:** exclude `owner_kind='teacher'` refs from step 12 in both db files. Teacher media is removed only by the existing teacher delete endpoint or quota cleanup.
   - **Shared drop media:** make the `drop_media` GC check that no other drop and no teacher ref uses the key before deleting the blob.
7. **Join errors:**
   - `fetchCourseFeed` throws an `Error` with `.status = res.status`. Apply the same convention to `listDrop` and `submitToDrop`, and reuse it in R2's `describeRelayError`.
   - `join-service.js` branches on `err.status === 404 || 410`.
   - Don't create a pending class on `not_found`.
   - Limit `moved_to` forwarding to 3 hops.
   - Make `router.js:_handleJoinRoute` show a message for every status: `not_found`, `untrusted_relay`, `duplicate_name`, `offline`.
   - Add a one-off cleanup on student boot that removes existing `course-pending-*` rows with no feed after 7 days.

### Tests (`tests/phase47-relay-ingest.test.js`)

Run against the Node handler, and against D1 through the existing test harness in `phase37-cloudflare-worker-and-connect.test.js`:
- 150 submissions with identical `received_at`: paging returns all 150 exactly once.
- One corrupt item in the middle: everything else imports, and the corrupt one is reported.
- Inbox pull, then navigate away, then come back: the items are still staged.
- The same task envelope imported twice is counted as 1 duplicate.
- An expired feed returns 410 with no ETag.
- A teacher media ref older than 24 h survives the prune.
- Joining with an unknown code against a 404 returns `not_found` and creates no pending class.

### Acceptance

Every submission the relay accepted ends up visible to the teacher exactly once. Bad items are reported, never silently skipped, and never block the rest.

---

## R4: Replication data safety

### Problems (evidence)

1. **The outbox is pruned past failing channels.** `replication/manager.js:246-254` takes the min cursor over successful channels only, so unsent rows for a failing class channel are deleted.
2. **Gap recovery applies chunks anyway.** In `replication/engine.js:331-345`, if the recovery snapshot still doesn't cover `prev_end`, the chunk is applied and the vector moves past the gap. A corrupt chunk (`:318-329`) is quarantined again on every poll.
3. **The pull cursor never moves.** `engine.js:299` reads `repl_list_cursor` and `:356` writes the same value back. `RelayChannel.listChunks` returns `cursor` (`channels.js:116-126`), but the engine drops it, so every poll downloads every chunk.
4. **One large record blocks its channel forever.** The 768 KB chunk target (`engine.js:20`) is measured before compression, encryption and base64, while the server rejects anything over 1 MB (`server/relay/limits.js` `MAX_SYNC_CHUNK_SIZE`). The first change in a batch is always included (`:224`).
5. **The HLC compares strings, and legacy `updated_at` values beat it.** `engine.js:376-377,402,415` and `merge.js:18` fall back to ISO dates, which sort above HLC strings. The clock state is in memory only (`hlc.js:72`).
6. **Edits are lost on tab close.** `manager.js:284` skips ticks when the tab is hidden, so an edit followed by closing within the 15 s debounce is never pushed.
7. **Failures don't reach the UI.** Quarantine, gaps and `getBlob` failures (`engine.js:398`) leave the status at "idle". Only `data-safety.js:316` listens for `kb-replication-status`.

### Fix steps

1. **Prune by the slowest channel:** min of `pushedThrough()` over **all** active engines, including ones that failed or are in backoff, in `manager.js`. If any channel has never pushed, don't prune.
2. **Make gap handling strict.**
   - If the snapshot still doesn't cover `prev_end`, quarantine the chunk once and **stop processing that device** for this pull. Don't apply later chunks from the same device and don't advance its vector.
   - Record a `gap` problem on the channel status.
   - Dedupe `repl_quarantine` rows by `(channel, deviceId, start, end)`.
3. **Advance the pull cursor safely.**
   - Use the `cursor` returned by `listChunks`, but persist only up to the highest `seq` S such that every chunk with seq ≤ S was applied, skipped as already covered, or belongs to this device.
   - A device stopped by a gap pins the cursor at its first unresolved chunk.
   - Keep the vector check as the guard against applying a chunk twice.
4. **Size chunks by encoded size:**
   - Measure the sealed, base64 body. If it's over 900 KB, split the batch in half and retry.
   - If a single op is still too big, mark it `oversize` in the outbox, skip it with a visible status problem ("1 item too large to sync – reduce embedded media"), and keep going. Don't block the channel.
   - Leave the `putBlob` fallback as is; it isn't needed for this fix.
5. **Fix the HLC:**
   - Add `compareStamp(a, b)` in `hlc.js`. It parses `wall-counter-device` into numbers. Treat a legacy ISO `updated_at` as `{wall: Date.parse(iso), counter: 0, device: ''}`.
   - Replace raw string comparisons in `engine.js` and `merge.js` with it.
   - Persist the HLC's last stamp in metadata on each `now()` (throttled), and restore it at startup.
6. **Flush on leave:** listen for `visibilitychange` → hidden and for `pagehide`, then call `syncNow({pushOnly:true})` without the visibility guard.
7. **Surface failures:**
   - Add `problems[]` to the status object (`gap`, `quarantine`, `oversize`, `auth`, `quota`).
   - Show a badge in `app-nav` and the details in `components/data-safety.js` whenever `problems.length > 0`.
8. **Stop-sharing cleanup:** when a class stops sharing, call `syncDeleteWorkspace` for that channel.

### Tests (`tests/phase48-replication-safety.test.js`)

Use `MemoryChannel` with failure injection:
- Two channels, one failing: after 3 syncs, the failing channel's rows are still in the outbox, and they deliver once it recovers.
- A missing chunk with no snapshot: the vector doesn't advance and the status shows `gap`.
- The cursor advances across polls, and the second poll downloads 0 bodies.
- A 2 MB record: the channel keeps syncing other records and the status shows `oversize`.
- A record with legacy ISO `updated_at` loses to a newer HLC edit.
- The HLC survives a simulated reload.
- `pagehide` triggers a push.

### Acceptance

Edits are never discarded while a channel fails. A gap never moves silently past missing data, and every sync problem shows up in the UI.

---

## R5: Feedback return and notifications

### Problems (evidence)

1. **Relay feedback is never fetched.** The teacher's "Push Feedback to Blind Relay" (`tasks/submissions.js:600-650`) publishes to `/feedback/:blindId`, but `FeedbackCapsule.fetchStudentRemoteFeedback` (`core/feedback-capsule.js:356`) has no callers. Assessments have no relay feedback at all.
2. **Capsule feedback is saved in the wrong shape.** `saveFeedbackToStudentStorage` (`feedback-capsule.js:262-280`) writes a separate `fb-…` row with no `course_id/title/score/item_type`, so `student/gradebook.js:125-156` shows an untitled "Awaiting grade". `pwa.js:148-151` decrypts with only the first access code in the keychain.
3. **Feedback links navigate too early.** `router.js:656-669` doesn't await `ingest*Feedback`, shows the success toast first, and navigates. Nothing listens for `kb-student-ledger-updated`.
4. **Students get no notifications.** The badge is forced to 0 in student mode (`main.js:384-388`), and ledger rows have no seen/unread state.
5. **The teacher Inbox badge is wrong.**
   - `main.js:394` counts `needs_review`/`has_manual_questions`, which are never set.
   - `main.js:395` counts `review.status==='submitted'`, which means "on time", so graded tasks count forever. Superseded rows are counted too.
   - It refreshes only on hashchange.
   - `home-stats.js:86` uses a different rule.
6. **The student gradebook shows unreleased self-check scores.** `ledger.js:438-442` stores `clientScore` as `score`, and it counts toward the overall average even when `release_grade_immediately=false`.
7. **`returned_at` is never set.** As a result `resubmitted_after_feedback` never triggers. In addition, ledger readers expect fields that are never written: `course-detail.js:129` uses `entry.percent`, and `adaptive-engine.js:61` runs `Number(entry.score)` on an object, which gives NaN.

### Fix steps

1. **One feedback ingest function.** Add `StudentLedger.applyFeedback({kind, itemId, courseId, title, score, maxScore, percent, feedback, released_at, source})`. It merges into the **existing** ledger entry for that item (matched by `item_id` plus `student_id`) instead of writing a separate `fb-` row.
   - Route `FeedbackCapsule.saveFeedbackToStudentStorage`, the router `ingest*Feedback` and the relay fetch through it.
   - Set `feedback_unseen = true` and `feedback_received_at`.
   - Dispatch `kb-student-ledger-updated`.
2. **Student relay feedback polling.**
   - Add `src/modules/student/feedback-poller.js`. On student boot, on `visibilitychange` → visible, and every 5 minutes while visible, it calls `fetchStudentRemoteFeedback` for each handed-in item whose payload had `relay` and that has no feedback yet. Throttle to at most 1 request per item per 5 minutes, which respects the server's 60/min feed and feedback limiter.
   - Try each access code in the keychain whose class matches the item's `course_id`, not just the first (this also fixes `pwa.js:148-151`).
   - Extend the teacher push to assessments: add "Return feedback via server" in `assignments/submissions.js`, reusing `FeedbackCapsule.publishBatchToRelay` (`feedback-capsule.js:310`, the method behind the existing task push).
3. **Router feedback links:** `await` the ingest, toast success only after it resolves, toast `danger` on failure, then navigate. `student/gradebook.js` and `student/course-detail.js` re-render on `kb-student-ledger-updated`.
4. **Student notifications:**
   - Show a student nav badge with the count of ledger entries where `feedback_unseen` is set. Remove the forced 0 in `main.js:384-388`.
   - Show a "New feedback" pill on gradebook and course-detail rows. Viewing the feedback clears `feedback_unseen`.
   - Toast once per new item: "Feedback returned for <title>", with a "View" action through the existing `toast.action`.
5. **Teacher badge, one rule.**
   - Add `countPendingReviews()` in `src/modules/home/home-stats.js` and use it in both `main.js` and Home.
   - Pending = latest-attempt rows (`is_latest !== false`) with no teacher grade: assessments with manual questions not yet graded, and tasks with no `review.graded_at` or `review.score`.
   - Refresh on a new `kb-submissions-changed` event, dispatched from `recordTaskSubmission`, the assessment import, and grade saves (`tasks/review.js:790-802`, `assignments/submissions.js`), as well as on hashchange.
6. **Released vs self-check score.**
   - The ledger stores `client_score` separately.
   - `score` is set only when `release_grade_immediately` is true or teacher feedback arrives.
   - The gradebook average uses `score` only, and shows "Pending teacher grade" otherwise.
   - Fix `course-detail.js:129` to use the ledger's real fields.
   - Fix `adaptive-engine.js:61` to read `entry.score?.percent ?? entry.percent` and treat a missing value as "not completed".
7. **Mark returned.** Every send path (link, capsule, relay push, PDF) sets `returned_at` on the submission and dispatches `kb-submissions-changed`. The review list shows a "Returned" badge.
8. **Clean up orphan events:** remove dispatches nothing listens to, or wire them up. These include `kb-feedback-imported`, `kb-student-feed-updated`, `kb-relay-connected`, and the unused `lan-beacon.js` import surface. The listener `kb-role-changed` (`context-bar.js:31`) has no dispatcher: dispatch it from `src/state/role-mode.js` on change.

### Tests (`tests/phase49-feedback-notifications.test.js`)

- A teacher relay push, then the student poller, updates the existing ledger row with score and title and sets `feedback_unseen`. The badge shows 1, and viewing clears it.
- A capsule import gives a gradebook row with title and score.
- A router feedback link with an ingest failure shows a danger toast and no success toast.
- The teacher badge doesn't count a graded task or a superseded row, and it updates on `kb-submissions-changed` without navigating.
- An unreleased self-check score is excluded from the average.

### Acceptance

When a teacher returns feedback through any channel, the student sees a "New feedback" indicator without hunting for it. The teacher's badge equals the number of submissions that actually need grading.

---

## Backlog (verified, left out of this plan on purpose)

- Rate limiting:
  - The Worker uses only the in-memory limiter.
  - The draft limiter is keyed per IP, which penalizes a whole school network behind one IP.
  - `X-Forwarded-For` is trusted.
- Device tokens are never sent (`transport.js:324-325`), and the server only checks them when present.
- Worker `process.env` quota vars are ignored. D1 `putChunk` uses null for `NOT NULL` hash columns. Quota accounting drifts.
- Co-teacher scope: `assignment_submissions` aren't covered by `_inScopeSync` (`engine.js:565-569`).
- Class-code length is inconsistent (6/8/10). Regenerating the code orphans the feed (`course-feed.js:321` is never called).
- Revision hash includes `updated_at`, so the ETag changes on every publish. The editors never mark the feed dirty.
- `getPublicAppUrl` is unused, so links can point at localhost, `file://`, or drop the path.
- Task `.html` embeds the raw payload unescaped. `pwa.js` doesn't recognise `kind:'kb-task'`.
- Due time is ignored in `daysLate`. Lateness uses the student's clock.

These are good candidates for a second round after R1–R5 land.

## Verification (end to end, after each PR)

1. `npm test`: the whole suite passes, including the new phase45–49 suites.
2. Start the Node relay and the app:
   ```bash
   npm run relay
   ```
   ```bash
   npm start
   ```
   Add a teacher:
   ```bash
   npm run relay:add-teacher "T1" "Test Teacher"
   ```
3. Manual script in the in-app browser. Use two browser profiles or tabs, teacher and student; student mode comes from the role chooser.
   1. **Teacher:** create a class with a roster, create an assessment and an assignment (task), and link both to the class.
      - Publish the task from the **editor**, re-open the dialog, and check that the link and `drop_id` haven't changed.
      - Publish the assessment from the **Course page**.
   2. **Student:** join with the class code, complete both items, and hand in:
      - The task by relay.
      - The assessment by download, then by relay.
      - The receipt and ledger wording must match R2. Reload, and check it still shows "Handed in".
   3. **Teacher:** check that the Inbox badge shows 2. Pull from the Inbox, navigate away and back, and check the items are still staged. Import: there must be no duplicates.
   4. **Teacher:** grade both and return feedback via the server. Check that the badge drops to 0 and the rows show "Returned".
   5. **Student:** within 5 minutes, or on refocusing the tab, check the "New feedback" badge and toast. Open the feedback and check that the badge clears and the gradebook shows the title and score.
   6. Turn the relay off and repeat step 2 with file hand-in only. The student must see "File saved – upload it to your teacher". The teacher imports it through the Inbox, and the row is labeled "Assignment", not "Unknown".
4. **D1 parity:** run the R3 server tests against the D1 harness.
   ```bash
   npm run relay:cf:dev
   ```
   Smoke test the endpoints with `curl`: drop list paging with `after=`, and the expired-feed 410.
