# **Master Engineering Execution Blueprint: KennisBoost Tools**

## **System Persona & Directives for the Executing Agent**

You are an elite, autonomous Principal Frontend Architect and Lead Systems Engineer. Your objective is to execute this specification to build **KennisBoost Tools**—a production-grade, 100% client-side, local-first educational technology suite.

&nbsp;

**Strict Operational Constraints:**

&nbsp;

1. **Zero Backend:** There is no server, cloud database, or external API dependency for core operations. All persistence, cryptography, document generation, and rendering execute inside the client browser runtime.  
2. **No Build-Step Requirement (ESM Native):** Architect the application using native ES Modules (type="module") paired with an \<script type="importmap"\> in index.html and local /vendor/ fallbacks so the entire suite can run directly from a static file host (e.g., Cloudflare Pages, GitHub Pages) or a local static server without a complex Webpack/Vite compilation pipeline.  
3. **No Placeholders or Truncation:** When implementing modules, write complete algorithms, full mathematical formulas, explicit DOM bindings, and comprehensive error handling. Never leave // TODO comments or stub functions.  
4. **Accessibility & Security First:** Every view must conform to **WCAG 2.1 AA** standards via Shoelace Web Components and explicit ARIA management. Every user input string rendered to HTML, SVG, or MathML must pass through DOMPurify.

## **1\. Directory Topology & Dependency Manifest**

### **1.1 File Tree Structure**

Initialize the project workspace with the following exact directory topology:

&nbsp;

Plaintext

kennisboost-tools/

├── index.html                      \# Single-Page Application entry, ImportMap, App Shell

├── manifest.json                   \# PWA Web App Manifest for offline ChromeOS installability

├── sw.js                           \# Service Worker for offline asset & vendor caching

├── css/

│   ├── tailwind.output.css         \# Pre-compiled Tailwind utility classes \+ custom tokens

│   └── app.css                     \# Custom scrollbars, print media queries, KaTeX/Canvas overrides

├── vendor/                         \# Local fallback copies of ESM libraries (offline durability)

└── src/

&nbsp;&nbsp;&nbsp;&nbsp;├── main.js                     \# Bootloader, router initialization, global event listeners

&nbsp;&nbsp;&nbsp;&nbsp;├── router.js                   \# Hash-based router (\#/flashcards, \#/timeline, \#/video, \#/gradebook, \#/share)

&nbsp;&nbsp;&nbsp;&nbsp;├── state/

&nbsp;&nbsp;&nbsp;&nbsp;│   └── store.js                \# Reactive Pub/Sub state container & cross-module event bus

&nbsp;&nbsp;&nbsp;&nbsp;├── core/

&nbsp;&nbsp;&nbsp;&nbsp;│   ├── storage.js              \# KB-CORE-001: Dexie.js DB, OPFS Blob manager, Quota monitor

&nbsp;&nbsp;&nbsp;&nbsp;│   ├── sync.js                 \# KB-CORE-002: File System Access API auto-sync, 72h backup daemon

&nbsp;&nbsp;&nbsp;&nbsp;│   ├── validator.js            \# KB-CORE-003: Zod schemas, PapaParse CSV normalizer, Exporter factory

&nbsp;&nbsp;&nbsp;&nbsp;│   ├── crypto-share.js         \# KB-CORE-004: Web Crypto PBKDF2 \+ AES-GCM, LZ-String URL packer

&nbsp;&nbsp;&nbsp;&nbsp;│   └── sanitizer.js            \# Defensive Engineering: DOMPurify \+ Marked \+ KaTeX/Mhchem pipeline

&nbsp;&nbsp;&nbsp;&nbsp;├── modules/

&nbsp;&nbsp;&nbsp;&nbsp;│   ├── flashcards/

&nbsp;&nbsp;&nbsp;&nbsp;│   │   ├── index.js            \# Module controller & Deck Library UI

&nbsp;&nbsp;&nbsp;&nbsp;│   │   ├── editor.js           \# KB-CARD-001: Live KaTeX preview, TTS config, Sketch pad binding

&nbsp;&nbsp;&nbsp;&nbsp;│   │   ├── sketch-canvas.js    \# KB-CARD-001: PointerEvent pressure-sensitive vector canvas \+ Undo stack

&nbsp;&nbsp;&nbsp;&nbsp;│   │   ├── fsrs.js             \# KB-CARD-002: Complete FSRS v4 mathematical scheduler engine

&nbsp;&nbsp;&nbsp;&nbsp;│   │   ├── study-player.js     \# KB-CARD-002: Review session UI, keyboard shortcuts, TTS Web Speech

&nbsp;&nbsp;&nbsp;&nbsp;│   │   └── tower-defense.js    \# KB-CARD-003: 60FPS HTML5 Canvas Tower Defense game engine

&nbsp;&nbsp;&nbsp;&nbsp;│   ├── timeline/

&nbsp;&nbsp;&nbsp;&nbsp;│   │   ├── index.js            \# Module controller & Filter toolbar

&nbsp;&nbsp;&nbsp;&nbsp;│   │   ├── canvas-renderer.js  \# KB-TIME-001: Temporal zoom engine, lane collision solver, ARIA nav

&nbsp;&nbsp;&nbsp;&nbsp;│   │   └── svg-exporter.js     \# KB-TIME-002: Standalone vector SVG serializer & CSV mapper

&nbsp;&nbsp;&nbsp;&nbsp;│   ├── video/

&nbsp;&nbsp;&nbsp;&nbsp;│   │   ├── index.js            \# Module controller (Editor vs. Kiosk mode switch)

&nbsp;&nbsp;&nbsp;&nbsp;│   │   ├── drivers.js          \# KB-VID-001: Unified adapter for HTML5 Video, YouTube IFrame, Vimeo SDK

&nbsp;&nbsp;&nbsp;&nbsp;│   │   ├── interceptor.js      \# KB-VID-001: 250ms playhead gatekeeper, scrub-blocker, modal trigger

&nbsp;&nbsp;&nbsp;&nbsp;│   │   └── kiosk-report.js     \# KB-VID-002: Student Kiosk view, .kbr cryptographic receipt, PDF print

&nbsp;&nbsp;&nbsp;&nbsp;│   └── gradebook/

&nbsp;&nbsp;&nbsp;&nbsp;│       ├── index.js            \# Module controller, Course/Term switcher

&nbsp;&nbsp;&nbsp;&nbsp;│       ├── virtual-grid.js     \# Defensive Eng: 2D Virtualized spreadsheet (150x80 cell windowing)

&nbsp;&nbsp;&nbsp;&nbsp;│       ├── engine-calc.js      \# KB-GRAD-001/002: Term weights, Traditional, Decaying Avg, Marzano Power Law, Mode

&nbsp;&nbsp;&nbsp;&nbsp;│       ├── rubric-builder.js   \# KB-GRAD-003: NxM weighted rubric designer & interactive click-scorer

&nbsp;&nbsp;&nbsp;&nbsp;│       └── report-generator.js \# KB-GRAD-004: jsPDF-autotable single/batch ZIP export & AES-GCM student links

&nbsp;&nbsp;&nbsp;&nbsp;└── utils/

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;├── uuid.js                 \# crypto.randomUUID() wrapper with fallback

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;└── toast.js                \# Shoelace \<sl-alert\> programmatic notification dispatcher

&nbsp;

### **1.2 Import Map & Pinned CDN Dependencies (index.html)**

Configure the \<head\> of index.html with the following exact pinned versions to guarantee deterministic behavior:

&nbsp;

HTML

\<\!-- Shoelace Web Components (WCAG 2.1 AA) \--\>

\<link rel="stylesheet" href="https\://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.0/cdn/themes/light.css" /\>

\<link rel="stylesheet" href="https\://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.0/cdn/themes/dark.css" /\>

\<script type="module" src="https\://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.15.0/cdn/shoelace-autoloader.js"\>\</script\>

&nbsp;

\<\!-- KaTeX \+ Mhchem for STEM Notation \--\>

\<link rel="stylesheet" href="https\://cdn.jsdelivr.net/npm/katex@0.16.10/dist/katex.min.css" /\>

\<script defer src="https\://cdn.jsdelivr.net/npm/katex@0.16.10/dist/katex.min.js"\>\</script\>

\<script defer src="https\://cdn.jsdelivr.net/npm/katex@0.16.10/dist/contrib/mhchem.min.js"\>\</script\>

\<script defer src="https\://cdn.jsdelivr.net/npm/katex@0.16.10/dist/contrib/auto-render.min.js"\>\</script\>

&nbsp;

\<\!-- Native ESM Import Map \--\>

\<script type="importmap"\>

{

&nbsp;&nbsp;"imports": {

&nbsp;&nbsp;&nbsp;&nbsp;"dexie": "https\://cdn.jsdelivr.net/npm/dexie@4.0.4/dist/dexie.mjs",

&nbsp;&nbsp;&nbsp;&nbsp;"zod": "https\://cdn.jsdelivr.net/npm/zod@3.23.8/+esm",

&nbsp;&nbsp;&nbsp;&nbsp;"lz-string": "https\://cdn.jsdelivr.net/npm/lz-string@1.5.0/+esm",

&nbsp;&nbsp;&nbsp;&nbsp;"papaparse": "https\://cdn.jsdelivr.net/npm/papaparse@5.4.1/+esm",

&nbsp;&nbsp;&nbsp;&nbsp;"marked": "https\://cdn.jsdelivr.net/npm/marked@12.0.2/+esm",

&nbsp;&nbsp;&nbsp;&nbsp;"dompurify": "https\://cdn.jsdelivr.net/npm/dompurify@3.1.5/+esm",

&nbsp;&nbsp;&nbsp;&nbsp;"jspdf": "https\://cdn.jsdelivr.net/npm/jspdf@2.5.1/+esm",

&nbsp;&nbsp;&nbsp;&nbsp;"jspdf-autotable": "https\://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/+esm",

&nbsp;&nbsp;&nbsp;&nbsp;"jszip": "https\://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm"

&nbsp;&nbsp;}

}

\</script\>

&nbsp;

## **2\. Epic 1: Cross-Cutting Core Architecture & Platform Services**

### **2.1 Storage Router & OPFS Hybrid Manager (src/core/storage.js) — *Implements KB-CORE-001***

#### **Database Schema Definition**

Instantiate a singleton StorageManager wrapping Dexie:

&nbsp;

JavaScript

import Dexie from 'dexie';

&nbsp;

export class StorageManager {

&nbsp;&nbsp;constructor() {

&nbsp;&nbsp;&nbsp;&nbsp;this.db \= new Dexie('KennisBoostDB');

&nbsp;&nbsp;&nbsp;&nbsp;this.ephemeralMode \= false;

&nbsp;&nbsp;&nbsp;&nbsp;this.memoryStore \= new Map();

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;this.db.version(1).stores({

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;flashcards: 'id, title, updated\_at',

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;timelines: 'id, title, updated\_at',

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;video\_assessments: 'id, title, updated\_at',

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;gradebook\_courses: 'id, name, academic\_year',

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;gradebook\_students: 'id, course\_id, student\_id, full\_name',

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;gradebook\_assignments: 'id, course\_id, term\_id, category, due\_date',

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;gradebook\_grades: '\[student\_id+assignment\_id\], course\_id, student\_id, assignment\_id, status',

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;gradebook\_rubrics: 'id, course\_id, title',

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;app\_metadata: 'key',

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;binary\_blobs: 'id, mime\_type, size\_bytes'

&nbsp;&nbsp;&nbsp;&nbsp;});

&nbsp;&nbsp;}

}

&nbsp;

#### **Implementation Mechanics**

1. **Boot & Quota Check (init()):**  
   1. Execute await this.db.open(). Catch Dexie.InvalidStateError or QuotaExceededError (common in strict Incognito/Private windows): set this.ephemeralMode \= true, route all CRUD calls to this.memoryStore, and trigger a non-dismissible Shoelace \<sl-dialog\> warning the user that Private Browsing is active and data must be manually exported before tab closure.  
   2. Bind a one-time listener on window (pointerdown or keydown) to invoke navigator.storage.persist(). Record result in app\_metadata under is\_persistent.  
   3. Call const { usage, quota } \= await navigator.storage.estimate(). If (usage / quota) \> 0.80, dispatch a warning \<sl-alert variant="warning" duration="10000"\> detailing exact MB used and providing direct action buttons to purge unused binary blobs or export an archive.  
2. **Binary Routing Threshold (64KB Rule):**  
   1. Expose saveBinaryAsset(id, blob). Check blob.size \> 65536 (64KB).  
   2. If navigator.storage && navigator.storage.getDirectory is supported, obtain the OPFS root (const root \= await navigator.storage.getDirectory()), create/open a subdirectory assets, write the Blob via createWritable(), and return the URI reference opfs://assets/\${id}.  
   3. If OPFS is unavailable, store the Blob directly inside the binary\_blobs IndexedDB object store and return idb-blob://\${id}.  
   4. Expose loadBinaryAsset(uri) which resolves opfs:// or idb-blob:// into an active URL.createObjectURL(blob) and registers it in an internal disposal map to revoke URLs on view unmount.

### **2.2 Automated State Snapshots & File System Access Sync (src/core/sync.js) — *Implements KB-CORE-002***

#### **Implementation Mechanics**

1. **File Handle Acquisition:**  
   1. Provide configureAutoSyncFile(). Feature-detect 'showSaveFilePicker' in window.  
   2. When invoked, call:  
   3. JavaScript

this.fileHandle \= await window.showSaveFilePicker({

&nbsp;&nbsp;suggestedName: 'kennisboost\_backup.json',

&nbsp;&nbsp;types: \[{ description: 'KennisBoost JSON Archive', accept: { 'application/json': \['.json'\] } }\]

});

4. &nbsp;  
   5. Store the FileSystemFileHandle reference in app\_metadata (key: 'autosync\_file\_handle'). Note: IndexedDB natively supports cloning FileSystemFileHandle objects.  
2. **Debounced Auto-Write Daemon:**  
   1. Subscribe to all write mutations on StorageManager via Dexie hooks (creating, updating, deleting) or the global state store.  
   2. Maintain a 5,000ms debounce timer (clearTimeout / setTimeout). When settled:  
      1. Verify permission on this.fileHandle via await this.fileHandle.queryPermission({ mode: 'readwrite' }). If 'prompt', show a subtle top-bar button "Re-authorize Auto-Sync" so user gesture can invoke requestPermission().  
      2. Serialize all IndexedDB tables into a master snapshot JSON object { version: 1, exported\_at: new Date().toISOString(), data: { ... } }.  
      3. Write via const writable \= await this.fileHandle.createWritable(); await writable.write(JSON.stringify(snapshot)); await writable.close();.  
      4. Update last\_manual\_export\_timestamp in app\_metadata to Date.now().  
3. **Fallback Blob Download (Firefox / Safari):**  
   1. If showSaveFilePicker is unsupported, exportManualBackup() generates a Blob(\[JSON.stringify(snapshot, null, 2)\], { type: 'application/json' }), formats the current date as YYYY-MM-DD, triggers a programmatic \<a download="kennisboost\_backup\_YYYY-MM-DD.json"\> click, and updates last\_manual\_export\_timestamp.  
4. **72-Hour Stale Backup Check:**  
   1. On application boot, read last\_manual\_export\_timestamp and snooze\_backup\_until from app\_metadata.  
   2. If last\_manual\_export\_timestamp exists and Date.now() \- last\_manual\_export\_timestamp \> 259200000 (72 hours) and Date.now() \> (snooze\_backup\_until || 0):  
   3. Render a modal \<sl-dialog label="Data Backup Recommended"\> with exact text: *"You have not backed up your local data in over 3 days. Would you like to export now?"*  
   4. Wire buttons:  
      1. **Export Backup**: Calls exportManualBackup(), updates last\_manual\_export\_timestamp \= Date.now(), closes modal.  
      2. **Remind Tomorrow**: Sets snooze\_backup\_until \= Date.now() \+ 86400000 (24 hours), closes modal.  
      3. **Dismiss**: Closes modal for the current session.

### **2.3 Deterministic Schema Validation & Universal Import/Export (src/core/validator.js) — *Implements KB-CORE-003***

#### **Complete Zod Schema Contracts**

Define and export strict Zod schemas for all domain entities:

&nbsp;

JavaScript

import { z } from 'zod';

&nbsp;

export const FSRSStateSchema \= z.object({

&nbsp;&nbsp;state: z.number().int().min(0).max(3).default(0), // 0: New, 1: Learning, 2: Review, 3: Relearning

&nbsp;&nbsp;due: z.string().datetime(),

&nbsp;&nbsp;stability: z.number().nonnegative().default(0),

&nbsp;&nbsp;difficulty: z.number().min(0).max(10).default(0),

&nbsp;&nbsp;elapsed\_days: z.number().nonnegative().default(0),

&nbsp;&nbsp;scheduled\_days: z.number().nonnegative().default(0),

&nbsp;&nbsp;reps: z.number().int().nonnegative().default(0),

&nbsp;&nbsp;lapses: z.number().int().nonnegative().default(0),

&nbsp;&nbsp;last\_review: z.string().datetime().optional()

});

&nbsp;

export const StrokeSchema \= z.object({

&nbsp;&nbsp;color: z.string(),

&nbsp;&nbsp;size: z.number(),

&nbsp;&nbsp;mode: z.enum(\['pen', 'eraser'\]),

&nbsp;&nbsp;points: z.array(z.tuple(\[z.number(), z.number(), z.number()\])) // \[x, y, pressure\]

});

&nbsp;

export const FlashcardItemSchema \= z.object({

&nbsp;&nbsp;id: z.string().uuid(),

&nbsp;&nbsp;type: z.enum(\['text', 'latex', 'canvas', 'audio'\]).default('text'),

&nbsp;&nbsp;front: z.object({

&nbsp;&nbsp;&nbsp;&nbsp;text: z.string(),

&nbsp;&nbsp;&nbsp;&nbsp;mediaUrl: z.string().optional(),

&nbsp;&nbsp;&nbsp;&nbsp;sketchData: z.array(StrokeSchema).optional(),

&nbsp;&nbsp;&nbsp;&nbsp;ttsLang: z.string().default('en-US')

&nbsp;&nbsp;}),

&nbsp;&nbsp;back: z.object({

&nbsp;&nbsp;&nbsp;&nbsp;text: z.string(),

&nbsp;&nbsp;&nbsp;&nbsp;mediaUrl: z.string().optional(),

&nbsp;&nbsp;&nbsp;&nbsp;sketchData: z.array(StrokeSchema).optional(),

&nbsp;&nbsp;&nbsp;&nbsp;ttsLang: z.string().default('en-US')

&nbsp;&nbsp;}),

&nbsp;&nbsp;srs: z.object({ interval: z.number(), ease: z.number() }).optional(), // Legacy compatibility

&nbsp;&nbsp;fsrs: FSRSStateSchema.optional()

});

&nbsp;

export const FlashcardSetSchema \= z.object({

&nbsp;&nbsp;version: z.literal(1),

&nbsp;&nbsp;id: z.string().uuid(),

&nbsp;&nbsp;title: z.string().min(1).max(120),

&nbsp;&nbsp;updated\_at: z.string().datetime().optional(),

&nbsp;&nbsp;gamification\_stats: z.object({

&nbsp;&nbsp;&nbsp;&nbsp;high\_score: z.number().default(0),

&nbsp;&nbsp;&nbsp;&nbsp;longest\_streak: z.number().default(0),

&nbsp;&nbsp;&nbsp;&nbsp;accuracy: z.number().default(0)

&nbsp;&nbsp;}).optional(),

&nbsp;&nbsp;cards: z.array(FlashcardItemSchema)

});

&nbsp;

export const TimelineEventSchema \= z.object({

&nbsp;&nbsp;id: z.string().uuid().optional(),

&nbsp;&nbsp;title: z.string().min(1),

&nbsp;&nbsp;start\_date: z.string(), // ISO-8601 or signed year string (e.g. "-0044-03-15" or "1517-10-31")

&nbsp;&nbsp;end\_date: z.string().nullable().optional(),

&nbsp;&nbsp;category: z.string().default('General'),

&nbsp;&nbsp;description: z.string().default(''),

&nbsp;&nbsp;color: z.string().regex(/^\#\[0-9A-Fa-f\]{6}\$/).default('\#3b82f6'),

&nbsp;&nbsp;citations: z.string().optional(),

&nbsp;&nbsp;mediaUrl: z.string().optional()

});

&nbsp;

export const TimelineDatasetSchema \= z.object({

&nbsp;&nbsp;version: z.literal(1),

&nbsp;&nbsp;id: z.string().uuid(),

&nbsp;&nbsp;title: z.string().min(1),

&nbsp;&nbsp;view\_state: z.object({

&nbsp;&nbsp;&nbsp;&nbsp;zoom\_level: z.number().default(1),

&nbsp;&nbsp;&nbsp;&nbsp;focal\_epoch\_ms: z.number().default(0),

&nbsp;&nbsp;&nbsp;&nbsp;active\_tags: z.array(z.string()).default(\[\])

&nbsp;&nbsp;}).optional(),

&nbsp;&nbsp;events: z.array(TimelineEventSchema)

});

&nbsp;

export const VideoCheckpointSchema \= z.object({

&nbsp;&nbsp;id: z.string().uuid(),

&nbsp;&nbsp;timestamp\_sec: z.number().nonnegative(),

&nbsp;&nbsp;type: z.enum(\['single\_choice', 'multi\_choice', 'open\_response', 'note'\]),

&nbsp;&nbsp;prompt\_markdown: z.string().min(1),

&nbsp;&nbsp;options: z.array(z.object({

&nbsp;&nbsp;&nbsp;&nbsp;id: z.string(),

&nbsp;&nbsp;&nbsp;&nbsp;text: z.string(),

&nbsp;&nbsp;&nbsp;&nbsp;is\_correct: z.boolean(),

&nbsp;&nbsp;&nbsp;&nbsp;rationale: z.string().optional()

&nbsp;&nbsp;})).optional(),

&nbsp;&nbsp;keywords: z.array(z.string()).optional(),

&nbsp;&nbsp;points: z.number().nonnegative().default(1)

});

&nbsp;

export const VideoAssessmentSchema \= z.object({

&nbsp;&nbsp;version: z.literal(1),

&nbsp;&nbsp;id: z.string().uuid(),

&nbsp;&nbsp;title: z.string().min(1),

&nbsp;&nbsp;provider: z.enum(\['html5', 'youtube', 'vimeo'\]),

&nbsp;&nbsp;video\_source: z.string().min(1),

&nbsp;&nbsp;checkpoints: z.array(VideoCheckpointSchema)

});

&nbsp;

#### **CSV Header Alias Normalization & Atomic Rollback**

1. **Alias Dictionary (HEADER\_ALIASES):**  
2. JavaScript

const HEADER\_ALIASES \= {

&nbsp;&nbsp;'student\_name': 'fullName', 'student name': 'fullName', 'fullname': 'fullName', 'name': 'fullName',

&nbsp;&nbsp;'student\_id': 'studentId', 'student id': 'studentId', 'id': 'studentId', 'sis\_id': 'studentId',

&nbsp;&nbsp;'start\_date': 'start\_date', 'start date': 'start\_date', 'begin': 'start\_date', 'date': 'start\_date',

&nbsp;&nbsp;'end\_date': 'end\_date', 'end date': 'end\_date', 'end': 'end\_date',

&nbsp;&nbsp;'question': 'front', 'term': 'front', 'prompt': 'front',

&nbsp;&nbsp;'answer': 'back', 'definition': 'back'

};

3. &nbsp;  
4. **Ingest Pipeline:**  
   1. Parse CSV via Papa.parse(csvString, { header: true, dynamicTyping: true, skipEmptyLines: 'greedy', transformHeader: h \=\> HEADER\_ALIASES\[h.trim().toLowerCase()\] || h.trim().toLowerCase() }).  
   2. Validate row-by-row against the target Zod schema using schema.safeParse(row).  
   3. Collect all errors into an array of { rowNumber, fieldPath, message, receivedValue }.  
   4. **Atomic Transaction:** If errors.length \> 0, abort before opening any Dexie transaction and open \<sl-dialog label="Import Validation Failed"\> displaying a structured table of exact line/row numbers, offending keys, and human-readable remediation tips. If errors.length \=== 0, commit all records inside await db.transaction('rw', targetTable, async () \=\> { ... }).  
5. **Exporter Factory:**  
   1. Exporter.toCSV(dataset, schema): Validates data with schema, flattens nested properties, and invokes Papa.unparse(dataset, { quotes: true }).  
   2. Exporter.toJSON(dataset): Returns pretty-printed JSON with schema version header.  
   3. Exporter.toMarkdown(dataset): Formats flashcards as Q/A tables, timelines as chronological bulleted lists, or gradebooks as GFM tables.

### **2.4 Client-Side URL Serialization & Zero-Backend Cryptographic Sharing (src/core/crypto-share.js) — *Implements KB-CORE-004***

#### **Cryptographic Binary Format Specification**

To avoid bloating JSON with multiple Base64 strings, pack encrypted payloads into a single binary buffer before Base64/LZ-String encoding:

&nbsp;

* **Bytes 0..15 (16 bytes):** Random PBKDF2 Salt (crypto.getRandomValues(new Uint8Array(16)))  
* **Bytes 16..27 (12 bytes):** Random AES-GCM Initialization Vector (crypto.getRandomValues(new Uint8Array(12)))  
* **Bytes 28..N:** AES-GCM Ciphertext (includes 128-bit authentication tag)

#### **Implementation Algorithms**

JavaScript

import LZString from 'lz-string';

&nbsp;

export class CryptoShareEngine {

&nbsp;&nbsp;static async deriveKey(passphrase, saltUint8) {

&nbsp;&nbsp;&nbsp;&nbsp;const enc \= new TextEncoder();

&nbsp;&nbsp;&nbsp;&nbsp;const keyMaterial \= await crypto.subtle.importKey(

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;'raw', enc.encode(passphrase), { name: 'PBKDF2' }, false, \['deriveKey'\]

&nbsp;&nbsp;&nbsp;&nbsp;);

&nbsp;&nbsp;&nbsp;&nbsp;return crypto.subtle.deriveKey(

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{ name: 'PBKDF2', salt: saltUint8, iterations: 100000, hash: 'SHA-256' },

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;keyMaterial,

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{ name: 'AES-GCM', length: 256 },

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;false,

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;\['encrypt', 'decrypt'\]

&nbsp;&nbsp;&nbsp;&nbsp;);

&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;static async createSharePayload(moduleType, dataObject, passphrase \= '') {

&nbsp;&nbsp;&nbsp;&nbsp;const envelope \= JSON.stringify({ v: 1, type: moduleType, payload: dataObject });

&nbsp;&nbsp;&nbsp;&nbsp;let compressed;

&nbsp;&nbsp;&nbsp;&nbsp;let isEncrypted \= false;

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;if (passphrase && passphrase.trim().length \> 0\) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;isEncrypted \= true;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const salt \= crypto.getRandomValues(new Uint8Array(16));

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const iv \= crypto.getRandomValues(new Uint8Array(12));

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const key \= await this.deriveKey(passphrase, salt);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const plaintextBytes \= new TextEncoder().encode(envelope);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const ciphertextBuf \= await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintextBytes);

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const packed \= new Uint8Array(16 \+ 12 \+ ciphertextBuf.byteLength);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;packed.set(salt, 0);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;packed.set(iv, 16);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;packed.set(new Uint8Array(ciphertextBuf), 28);

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;// Convert binary Uint8Array to binary string for LZString

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;let binStr \= '';

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;for (let i \= 0; i \< packed.byteLength; i++) binStr \+= String.fromCharCode(packed\[i\]);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;compressed \= LZString.compressToEncodedURIComponent(binStr);

&nbsp;&nbsp;&nbsp;&nbsp;} else {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;compressed \= LZString.compressToEncodedURIComponent(envelope);

&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;const baseUrl \= \`\${window.location.origin}\${window.location.pathname}\`;

&nbsp;&nbsp;&nbsp;&nbsp;const shareUrl \= \`\${baseUrl}\#/share?enc=\${isEncrypted ? '1' : '0'}\&d=\${compressed}\`;

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;return {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;url: shareUrl,

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;exceedsUrlLimit: shareUrl.length \> 2048,

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;rawFileContent: JSON.stringify({ enc: isEncrypted ? 1 : 0, d: compressed })

&nbsp;&nbsp;&nbsp;&nbsp;};

&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;static async unpackSharePayload(dParam, isEncrypted, passphrase \= '') {

&nbsp;&nbsp;&nbsp;&nbsp;const decompressed \= LZString.decompressFromEncodedURIComponent(dParam);

&nbsp;&nbsp;&nbsp;&nbsp;if (\!decompressed) throw new Error('CORRUPTED\_PAYLOAD');

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;if (\!isEncrypted) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;return JSON.parse(decompressed);

&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;const packed \= new Uint8Array(decompressed.length);

&nbsp;&nbsp;&nbsp;&nbsp;for (let i \= 0; i \< decompressed.length; i++) packed\[i\] \= decompressed.charCodeAt(i);

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;const salt \= packed.slice(0, 16);

&nbsp;&nbsp;&nbsp;&nbsp;const iv \= packed.slice(16, 28);

&nbsp;&nbsp;&nbsp;&nbsp;const ciphertext \= packed.slice(28);

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;const key \= await this.deriveKey(passphrase, salt);

&nbsp;&nbsp;&nbsp;&nbsp;try {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const decryptedBuf \= await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const jsonStr \= new TextDecoder().decode(decryptedBuf);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;return JSON.parse(jsonStr);

&nbsp;&nbsp;&nbsp;&nbsp;} catch (err) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;throw new Error('INVALID\_PASSPHRASE');

&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;&nbsp;}

}

&nbsp;

#### **UI Flow & Guardrails**

* **2,048-Character Guardrail:** When exceedsUrlLimit \=== true, display a warning modal explaining that the URL length (shareUrl.length chars) exceeds the 2,048-character safe threshold for proxy servers and LMS embeds, and automatically trigger a .kbshare file download containing rawFileContent.  
* **Decryption Modal & Shake Feedback:** When the router hits \#/share?enc=1\&d=..., suspend module initialization and open \<sl-dialog label="Protected Lesson"\>. On password failure (INVALID\_PASSPHRASE), apply CSS keyframe animation kb-shake 0.4s cubic-bezier(.36,.07,.19,.97) both, set aria-invalid="true" on \<sl-input\>, and announce *"Incorrect passphrase or corrupted payload"* inside an aria-live="assertive" container.  
* **Ephemeral Workspace Banner:** Once unpacked, load the data into an ephemeral state slice and render a persistent top banner offering two actions: **"Play/Study Instantly (Temporary)"** or **"Save to My Local Library"**.

### **2.5 Sanitization & STEM Rendering Pipeline (src/core/sanitizer.js) — *Defensive Engineering***

All user strings containing Markdown, LaTeX, or chemical equations must pass through a deterministic 3-stage pipeline before touching .innerHTML:

&nbsp;

1. **Tokenize Math & Chemistry Delimiters:** Extract block \$\$\[\\s\\S\]+?\$\$ and inline \\\$\[^\$\\n\]+\\\$ segments, replacing them with placeholder tokens @@KB\_MATH\_0@@ so marked does not mangle underscores (\_) or asterisks (\*) inside equations.  
2. **Render KaTeX \+ Mhchem:** Pass each extracted math expression to window.katex.renderToString(expr, { displayMode, throwOnError: false, trust: false }). Because mhchem.min.js is loaded, \\ce{H2 \+ O2 \-\> H2O} renders automatically.  
3. **Markdown Parse & Strict DOMPurify Filter:** Parse markdown with marked.parse(), restore rendered KaTeX strings into placeholders, and sanitize the combined output with DOMPurify.sanitize(html, { USE\_PROFILES: { html: true, svg: true, mathMl: true }, FORBID\_TAGS: \['script', 'iframe', 'object', 'embed', 'form'\], FORBID\_ATTR: \['onerror', 'onload', 'onclick', 'onmouseover'\] }).

## **3\. Epic 2: Flashcards & Gamified Study Engine**

### **3.1 Rich-Text, KaTeX/Mhchem, TTS & Vector Sketch Pad (src/modules/flashcards/editor.js & sketch-canvas.js) — *Implements KB-CARD-001***

1. **100ms Debounced Live Preview:**  
   1. Attach input listeners to Front and Back \<sl-textarea\> controls.  
   2. Wrap the preview update in a 100ms debounce timer that invokes Sanitizer.renderSTEMMarkdown(value) and updates the side-by-side preview pane without layout jitter.  
2. **Text-to-Speech (Web Speech API):**  
   1. Query available OS voices via window.speechSynthesis.getVoices() (listening to onvoiceschanged).  
   2. Provide an ISO-639-1 language selector (en-US, es-ES, fr-FR, de-DE, zh-CN, ja-JP, etc.) plus a lightweight heuristic auto-detector (checking Unicode ranges for CJK/Cyrillic/Arabic or common stopwords).  
   3. Before speaking, strip LaTeX delimiters (\$, \\ce{...}, \\frac) into readable text so the synthesizer does not read raw backslashes.  
   4. Bind Rate (0.5 to 2.0, default 1.0) and Pitch (0.5 to 1.5, default 1.0) sliders inside the study settings \<sl-drawer\>.  
3. **Pressure-Sensitive Vector Sketch Canvas (sketch-canvas.js):**  
   1. Render an HTML5 \<canvas\> normalized to 1000 x 600 logical coordinate units scaled by window.devicePixelRatio.  
   2. Bind pointerdown, pointermove, and pointerup with canvas.setPointerCapture(e.pointerId) and CSS touch-action: none to prevent page scrolling while drawing on tablets/touchscreens.  
   3. Capture normalized integer coordinates and pressure:  
   4. JavaScript

const x \= Math.round((e.offsetX / canvas.clientWidth) \* 1000);

const y \= Math.round((e.offsetY / canvas.clientHeight) \* 600);

const p \= Math.round((e.pressure || 0.5) \* 100\) / 100;

currentStroke.points.push(\[x, y, p\]);

5. &nbsp;  
   6. Dynamic line width per segment: ctx.lineWidth \= stroke.size \* (0.5 \+ point\[2\] \* 1.5).  
   7. Maintain a strokes array and redoStack array capped at **20 undo states**. Operations: Pen, Eraser (globalCompositeOperation \= 'destination-out'), Clear, Undo, and Stroke Color (\<sl-color-picker\>).  
   8. Serialize strokes directly into card.front.sketchData as compact JSON arrays.

### **3.2 FSRS v4 Spaced Repetition Scheduler (src/modules/flashcards/fsrs.js) — *Implements KB-CARD-002***

Implement the complete **FSRS v4.5 / v4** mathematical model with standard default weights \$w\_0 \\dots w\_{16}\$:

&nbsp;

JavaScript

export class FSRSEngine {

&nbsp;&nbsp;constructor() {

&nbsp;&nbsp;&nbsp;&nbsp;// Standard calibrated FSRS v4 default parameters

&nbsp;&nbsp;&nbsp;&nbsp;this.w \= \[

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0.4, 0.6, 2.4, 5.8, // w0..w3: Initial stability for Again(1), Hard(2), Good(3), Easy(4)

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;4.93,               // w4: Initial difficulty base

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0.94,               // w5: Initial difficulty rating multiplier

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0.86,               // w6: Difficulty delta multiplier

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0.01,               // w7: Mean reversion weight

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;1.49,               // w8: Stability recall multiplier

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0.14,               // w9: Stability power decay

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0.94,               // w10: Retrievability exponential factor

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;2.18,               // w11: Post-lapse stability base

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0.05,               // w12: Post-lapse difficulty power

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0.34,               // w13: Post-lapse stability power

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;1.26,               // w14: Post-lapse retrievability factor

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;0.29,               // w15: Hard penalty multiplier

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;2.61                // w16: Easy bonus multiplier

&nbsp;&nbsp;&nbsp;&nbsp;\];

&nbsp;&nbsp;&nbsp;&nbsp;this.requestRetention \= 0.90;

&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;// Retrievability R(t, S) \= (1 \+ (19/81) \* (t / S)) ^ \-0.5

&nbsp;&nbsp;calculateRetrievability(elapsedDays, stability) {

&nbsp;&nbsp;&nbsp;&nbsp;if (stability \<= 0\) return 0;

&nbsp;&nbsp;&nbsp;&nbsp;return Math.pow(1 \+ (19 / 81\) \* (elapsedDays / stability), \-0.5);

&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;// Next interval in days for target retention R \= 0.90

&nbsp;&nbsp;nextInterval(stability) {

&nbsp;&nbsp;&nbsp;&nbsp;const interval \= (stability / (19 / 81)) \* (Math.pow(this.requestRetention, \-2) \- 1);

&nbsp;&nbsp;&nbsp;&nbsp;return Math.max(1, Math.round(interval));

&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;// Grade: 1 \= Again, 2 \= Hard, 3 \= Good, 4 \= Easy

&nbsp;&nbsp;reviewCard(card, grade, nowMs \= Date.now()) {

&nbsp;&nbsp;&nbsp;&nbsp;const w \= this.w;

&nbsp;&nbsp;&nbsp;&nbsp;const prev \= card.fsrs || { state: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, last\_review: null };

&nbsp;&nbsp;&nbsp;&nbsp;const elapsedDays \= prev.last\_review

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;? Math.max(0, (nowMs \- new Date(prev.last\_review).getTime()) / 86400000\)

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: 0;

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;let S \= prev.stability;

&nbsp;&nbsp;&nbsp;&nbsp;let D \= prev.difficulty;

&nbsp;&nbsp;&nbsp;&nbsp;let reps \= prev.reps;

&nbsp;&nbsp;&nbsp;&nbsp;let lapses \= prev.lapses;

&nbsp;&nbsp;&nbsp;&nbsp;let state \= prev.state;

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;if (state \=== 0\) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;// First review of a New card

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;S \= w\[grade \- 1\];

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;D \= Math.min(10, Math.max(1, w\[4\] \- (grade \- 3\) \* w\[5\]));

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;state \= grade \=== 1 ? 1 : 2;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;reps \= grade \=== 1 ? 0 : 1;

&nbsp;&nbsp;&nbsp;&nbsp;} else {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;// Subsequent review

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const R \= this.calculateRetrievability(elapsedDays, S);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const d0 \= w\[4\];

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const nextD \= D \- w\[6\] \* (grade \- 3);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;D \= Math.min(10, Math.max(1, w\[7\] \* d0 \+ (1 \- w\[7\]) \* nextD));

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if (grade \=== 1\) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;// Lapse (Forgot)

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;lapses \+= 1;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;reps \= 0;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;state \= 3; // Relearning

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;S \= Math.max(0.1, w\[11\] \* Math.pow(D, \-w\[12\]) \* (Math.pow(S \+ 1, w\[13\]) \- 1\) \* Math.exp(w\[14\] \* (1 \- R)));

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;} else {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;// Recall success (Hard, Good, Easy)

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;reps \+= 1;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;state \= 2; // Review

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const hardPenalty \= grade \=== 2 ? w\[15\] : 1;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const easyBonus \= grade \=== 4 ? w\[16\] : 1;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const factor \= Math.exp(w\[8\]) \* (11 \- D) \* Math.pow(S, \-w\[9\]) \* (Math.exp(w\[10\] \* (1 \- R)) \- 1\) \* hardPenalty \* easyBonus;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;S \= S \* (1 \+ factor);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;const scheduledDays \= grade \=== 1 ? 0 : this.nextInterval(S);

&nbsp;&nbsp;&nbsp;&nbsp;// If Again (grade 1), schedule 10 minutes ahead in current session; else scheduledDays

&nbsp;&nbsp;&nbsp;&nbsp;const dueTimestamp \= grade \=== 1 ? nowMs \+ 600000 : nowMs \+ scheduledDays \* 86400000;

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;return {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;state,

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;stability: Number(S.toFixed(4)),

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;difficulty: Number(D.toFixed(4)),

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;elapsed\_days: Number(elapsedDays.toFixed(2)),

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;scheduled\_days: scheduledDays,

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;reps,

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;lapses,

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;last\_review: new Date(nowMs).toISOString(),

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;due: new Date(dueTimestamp).toISOString(),

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;due\_timestamp: dueTimestamp

&nbsp;&nbsp;&nbsp;&nbsp;};

&nbsp;&nbsp;}

}

&nbsp;

#### **Queue Sorting & Keyboard Ergonomics**

* Filter deck for cards where (card.fsrs?.due\_timestamp ?? 0\) \<= Date.now().  
* Sort active review queue in ascending order of current retrievability $R(t,S)$ so cards with the **highest retrieval risk** (lowest $R$) appear first.  
* Bind window keydown events when Study Mode is active: Space flips the card; once flipped, keys 1 (Again), 2 (Hard), 3 (Good), and 4 (Easy) commit the FSRS grade and advance immediately.

### **3.3 Single-Player Gamified Study Mode: "Tower Defense" (src/modules/flashcards/tower-defense.js) — *Implements KB-CARD-003***

#### **Game Loop & Architecture**

1. **Canvas & Waypoint Map:**  
   1. Render a 960 x 420 HTML5 \<canvas\> above the multiple-choice question dock.  
   2. Define a multi-turn waypoint path array: const WAYPOINTS \= \[{x: 0, y: 120}, {x: 260, y: 120}, {x: 260, y: 300}, {x: 640, y: 300}, {x: 640, y: 160}, {x: 920, y: 160}\] leading to the Player Base at {x: 920, y: 160} (Base Health: 100 HP).  
   3. Place 6 interactive Tower Build Pads adjacent to the path segments.  
2. **Programmatic Vector Sprites (Zero External Assets):**  
   1. **Monsters:** Drawn via ctx.beginPath(), ctx.arc(), animated leg/antenna oscillations using Math.sin(performance.now() \* 0.01), and overhead floating health bars.  
   2. **Tower Types:**  
      1. **Archer Tower (Cost: 50 Energy):** Emerald polygon turret; fast single-target laser/arrow projectiles (fireRate: 1.2/s, damage: 25, range: 140px).  
      2. **Freeze Tower (Cost: 75 Energy):** Cyan hexagonal crystal; emits pulsing frost ring (fireRate: 0.6/s, damage: 10, applies slowFactor: 0.45 for 3.0s).  
      3. **Splash Cannon (Cost: 100 Energy):** Amber octagonal mortar; fires area-of-effect shells (fireRate: 0.4/s, damage: 45, splashRadius: 65px).  
3. **Quiz-Driven Resource & Cooldown Mechanics:**  
   1. Select a target card from the deck (prioritizing due FSRS cards). Sample 3 distinct distractor answers from other cards in the deck (if deck has fewer than 4 cards, generate algorithmic numeric/text variations). Shuffle options 1..4.  
   2. Bind keys 1, 2, 3, 4 and click handlers:  
      1. **Correct Answer:** Awards \+35 Energy, increments currentStreak, plays synthesized Web Audio API chime (OscillatorNode major triad), and loads next prompt immediately.  
      2. **Incorrect Answer:** Resets currentStreak \= 0, sets globalTurretJamUntil \= performance.now() \+ 2000 (2-second cooldown where all towers display a red "JAMMED" indicator and cease firing), flashes correct answer for 1.2s, then advances.  
4. **Persistence:**  
   1. At Wave 10 completion or Base HP reaching 0, update deck.gamification\_stats (high\_score, longest\_streak, accuracy) in IndexedDB.

## **4\. Epic 3: Interactive Timeline Maker**

### **4.1 Accessible Visual Timeline Canvas, Temporal Zoom & Lane Solver (src/modules/timeline/canvas-renderer.js) — *Implements KB-TIME-001***

#### **Extended Historical Date Parser**

Standard Date.parse() fails on early historical years or BCE dates. Implement parseHistoricalDateToDays(dateStr) which converts ISO strings (1517-10-31, \-0044-03-15, or year integers 1618\) into a continuous floating-point **Astronomical Julian Day / Epoch Day float** so centuries, decades, and hours scale linearly without precision loss.

&nbsp;

#### **Continuous Temporal Zoom Engine**

* Maintain pixelsPerDay (scale factor) and centerDay (focal point).  
* Bind wheel event on the timeline viewport (e.preventDefault()):  
  * Calculate cursor world day prior to zoom: cursorDay \= centerDay \+ (e.offsetX \- viewportWidth / 2\) / pixelsPerDay.  
  * Multiply pixelsPerDay by e.deltaY \< 0 ? 1.18 : 0.85, clamped between 1e-4 (Centuries view) and 2400 (Hours view).  
  * Adjust centerDay so cursorDay remains pinned directly underneath the user's cursor.  
* Dynamically select axis tick intervals based on pixelsPerDay:  
  * \> 120: **Hours**  
  * 10 .. 120: **Days**  
  * 0.5 .. 10: **Months**  
  * 0.05 .. 0.5: **Years**  
  * 0.005 .. 0.05: **Decades**  
  * \< 0.005: **Centuries**

#### **Greedy Interval Partitioning (Automated Collision & Lane Allocation)**

To prevent overlapping event cards or duration spans, run the following deterministic layout pass whenever zoom or filter state changes:

&nbsp;

JavaScript

export function assignTimelineLanes(events, dayToXFn, minGapPx \= 16\) {

&nbsp;&nbsp;// 1\. Project events to screen X intervals \[xStart, xEnd\]

&nbsp;&nbsp;const projected \= events.map(ev \=\> {

&nbsp;&nbsp;&nbsp;&nbsp;const xStart \= dayToXFn(ev.startDay);

&nbsp;&nbsp;&nbsp;&nbsp;const isSpan \= ev.endDay \!== null && ev.endDay \!== undefined && ev.endDay \> ev.startDay;

&nbsp;&nbsp;&nbsp;&nbsp;// Milestones require a minimum pill width based on title character count

&nbsp;&nbsp;&nbsp;&nbsp;const estimatedLabelWidth \= Math.max(130, ev.title.length \* 7.5 \+ 32);

&nbsp;&nbsp;&nbsp;&nbsp;const xEnd \= isSpan

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;? Math.max(dayToXFn(ev.endDay), xStart \+ estimatedLabelWidth)

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: xStart \+ estimatedLabelWidth;

&nbsp;&nbsp;&nbsp;&nbsp;return { ...ev, isSpan, xStart, xEnd };

&nbsp;&nbsp;}).sort((a, b) \=\> a.xStart \- b.xStart || b.xEnd \- a.xEnd);

&nbsp;

&nbsp;&nbsp;// 2\. Greedy lane packing

&nbsp;&nbsp;const laneLastEndPx \= \[\]; // Tracks rightmost occupied X coordinate per horizontal lane

&nbsp;&nbsp;for (const item of projected) {

&nbsp;&nbsp;&nbsp;&nbsp;let assignedLane \= \-1;

&nbsp;&nbsp;&nbsp;&nbsp;for (let laneIdx \= 0; laneIdx \< laneLastEndPx.length; laneIdx++) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if (item.xStart \>= laneLastEndPx\[laneIdx\] \+ minGapPx) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;assignedLane \= laneIdx;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;laneLastEndPx\[laneIdx\] \= item.xEnd;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;break;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;&nbsp;&nbsp;&nbsp;if (assignedLane \=== \-1) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;assignedLane \= laneLastEndPx.length;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;laneLastEndPx.push(item.xEnd);

&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;&nbsp;&nbsp;&nbsp;item.lane \= assignedLane;

&nbsp;&nbsp;}

&nbsp;&nbsp;return { items: projected, totalLanes: laneLastEndPx.length };

}

&nbsp;

#### **Keyboard Navigation & Screen Reader Accessibility**

* Maintain focusedEventIndex across the chronologically sorted projected array.  
* Bind ArrowLeft and ArrowRight on the timeline container:  
  * Decrement/increment focusedEventIndex.  
  * Smoothly pan centerDay if the focused event lies outside the visible horizontal viewport.  
  * Populate the hidden \<div id="timeline-aria-live" class="sr-only" aria-live="polite"\> with: "\${ev.title}, \${ev.end\_date ? Span from $ev.star{t}_{d}ateto${ev.end\_date}:Milestone on \${ev.start\_date}}, Category: \${ev.category}."  
* Bind Enter: Opens \<sl-drawer label="\${ev.title}" placement="end"\> rendering sanitized Markdown description, embedded image preview, and formatted academic citations.

### **4.2 Timeline Import, Export & Standalone Vector SVG Generator (src/modules/timeline/svg-exporter.js) — *Implements KB-TIME-002***

1. **CSV Ingest/Export:**  
   1. Enforce minimum columns: title, start\_date, end\_date, category, description, color.  
   2. During import, if end\_date is empty, null, or whitespace, normalize end\_date \= null and classify the event as a **Milestone**.  
2. **Standalone Vector .svg Serializer:**  
   1. Construct an XML string starting with \<?xml version="1.0" encoding="UTF-8"?\> and \<svg xmlns="\[http\://www\.w3.org/2000/svg\](http\://www\.w3.org/2000/svg)" viewBox="0 0 \${width} $height"width="${width}" height="\${height}"\>.  
   2. Embed a \<style\> block specifying system font stacks (font-family: system-ui, \-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;).  
   3. Render background gridlines, temporal axis ticks, era headers, horizontal span \<rect rx="6"\> bars with their exact hex fill="\${ev.color}", milestone \<circle\> nodes with connector stems, and XML-escaped \<text\> labels positioned using the exact coordinates from assignTimelineLanes().  
   4. Trigger download as timeline\_export.svg via Blob(\['image/svg+xml;charset=utf-8'\]).

## **5\. Epic 4: Video Assessment Player (Local EdPuzzle Alternative)**

### **5.1 Multi-Provider Video Driver & 250ms Playhead Gatekeeper (src/modules/video/drivers.js & interceptor.js) — *Implements KB-VID-001***

#### **Unified Provider Driver Abstraction**

Create a base interface VideoProviderDriver with concrete subclasses HTML5VideoDriver, YouTubeDriver, and VimeoDriver exposing identical asynchronous methods:

&nbsp;

* mount(containerEl, videoSource)  
* play(), pause(), seekTo(seconds), getCurrentTime(), getDuration()  
* **YouTube IFrame API Loader:** Dynamically inject \[https\://www\.youtube.com/iframe\_api\](https\://www\.youtube.com/iframe\_api) if window.YT is undefined. Instantiate new YT.Player(el, { videoId, playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0 } }).  
* **Vimeo SDK Loader:** Dynamically inject \[https\://player.vimeo.com/api/player.js\](https\://player.vimeo.com/api/player.js) if window.Vimeo is undefined. Instantiate new Vimeo.Player(el, { id: videoId, controls: false, keyboard: false }).  
* **HTML5 Native Video:** Render \<video src="\${videoSource}" playsinline preload="metadata"\> with native controls attribute omitted so the custom KennisBoost accessible scrubber bar governs playback.

#### **250ms Playhead Gatekeeper & Anti-Scrub Enforcement (interceptor.js)**

JavaScript

export class VideoGatekeeper {

&nbsp;&nbsp;constructor(driver, checkpoints, onTriggerCheckpoint) {

&nbsp;&nbsp;&nbsp;&nbsp;this.driver \= driver;

&nbsp;&nbsp;&nbsp;&nbsp;this.checkpoints \= checkpoints.sort((a, b) \=\> a.timestamp\_sec \- b.timestamp\_sec);

&nbsp;&nbsp;&nbsp;&nbsp;this.completedIds \= new Set();

&nbsp;&nbsp;&nbsp;&nbsp;this.maxReachedTime \= 0;

&nbsp;&nbsp;&nbsp;&nbsp;this.isLocked \= false;

&nbsp;&nbsp;&nbsp;&nbsp;this.lastPollMs \= 0;

&nbsp;&nbsp;&nbsp;&nbsp;this.rafId \= null;

&nbsp;&nbsp;&nbsp;&nbsp;this.onTriggerCheckpoint \= onTriggerCheckpoint;

&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;startLoop() {

&nbsp;&nbsp;&nbsp;&nbsp;const tick \= async (now) \=\> {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if (now \- this.lastPollMs \>= 250 && \!this.isLocked) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;this.lastPollMs \= now;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const currentTime \= await this.driver.getCurrentTime();

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;// 1\. Find earliest incomplete checkpoint

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const nextIncomplete \= this.checkpoints.find(cp \=\> \!this.completedIds.has(cp.id));

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;// 2\. Anti-Scrub Guard: Block seeking past unanswered checkpoints or unviewed video

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const allowedCeiling \= nextIncomplete

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;? Math.min(this.maxReachedTime \+ 1.0, nextIncomplete.timestamp\_sec \+ 0.35)

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: Math.max(this.maxReachedTime, currentTime);

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if (currentTime \> allowedCeiling \+ 0.5) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const snapTarget \= nextIncomplete && allowedCeiling \>= nextIncomplete.timestamp\_sec

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;? nextIncomplete.timestamp\_sec

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;: this.maxReachedTime;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;await this.driver.seekTo(snapTarget);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;this.rafId \= requestAnimationFrame(tick);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;return;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if (currentTime \> this.maxReachedTime) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;this.maxReachedTime \= currentTime;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;// 3\. Checkpoint Trigger Evaluation (t \+/- 0.35s window)

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if (nextIncomplete && Math.abs(currentTime \- nextIncomplete.timestamp\_sec) \<= 0.35) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;this.isLocked \= true;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;await this.driver.pause();

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if (document.fullscreenElement) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;await document.exitFullscreen().catch(() \=\> {});

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;this.onTriggerCheckpoint(nextIncomplete);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;this.rafId \= requestAnimationFrame(tick);

&nbsp;&nbsp;&nbsp;&nbsp;};

&nbsp;&nbsp;&nbsp;&nbsp;this.rafId \= requestAnimationFrame(tick);

&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;async resolveCheckpoint(checkpointId) {

&nbsp;&nbsp;&nbsp;&nbsp;this.completedIds.add(checkpointId);

&nbsp;&nbsp;&nbsp;&nbsp;this.isLocked \= false;

&nbsp;&nbsp;&nbsp;&nbsp;await this.driver.play();

&nbsp;&nbsp;}

}

&nbsp;

#### **Transparent Overlay & Checkpoint Evaluation**

* Place a \<div class="kb-video-shield"\> directly over the video iframe to intercept direct clicks that would bypass custom controls.  
* When onTriggerCheckpoint(cp) fires, open a non-closable \<sl-dialog no-header\> (e.preventDefault() on sl-request-close when e.detail.source \=== 'overlay' or 'keyboard').  
* **Evaluation Rules:**  
  * **Single/Multi-Choice:** Compare selected option IDs against is\_correct. Display per-option rationale feedback before unlocking the **"Continue Video"** button.  
  * **Open Response:** If cp.keywords is non-empty, perform case-insensitive substring matching (text.toLowerCase().includes(kw.toLowerCase())) to auto-score; otherwise mark status as "Pending Teacher Review" and award provisional completion.  
  * **Timestamp Note:** Render sanitized Markdown note and optional \<audio controls\> clip with an immediate **"Continue"** button.

### **5.2 Student Kiosk Mode & Cryptographic Receipt (.kbr) (src/modules/video/kiosk-report.js) — *Implements KB-VID-002***

1. **Kiosk Mode Activation:**  
   1. Activated automatically when loaded via \#/share or toggled via \#/video?kiosk=1. Hides all question creation controls, timeline editors, and global navigation bars.  
2. **Session Performance Report & .kbr Receipt:**  
   1. Upon video completion, compute totalScore, maxPossibleScore, firstAttemptPassCount, and responseLogs (with timestamps and latency).  
   2. **Cryptographic Signature (.kbr file):**  
      1. Compute a SHA-256 verification digest over $studentName|${assessmentId}|$totalScore|${completedIsoTimestamp}|\${JSON.stringify(responseLogs)} using crypto.subtle.digest('SHA-256', data).  
      2. Package the JSON receipt alongside the hex digest and compress via LZString into a downloadable \${student\_name}\_result.kbr file.  
      3. Provide a **"Verify Student Receipt (.kbr)"** dropzone in the Teacher Video view that recomputes the hash and verifies authenticity.  
   3. Provide a **"Print PDF Report"** button utilizing jsPDF \+ jspdf-autotable and a **"Copy Result Link"** button that encodes the signed summary into \#/video-result?r=....

## **6\. Epic 5: Comprehensive Browser Gradebook**

### **6.1 Academic Calendar, Terms & Advanced Calculation Engines (src/modules/gradebook/engine-calc.js) — *Implements KB-GRAD-001 & KB-GRAD-002***

#### **Term Management & Contribution Validation**

* Each course maintains an array of terms: \[{ id, name, start\_date, end\_date, weight\_pct }\].  
* Enforce validation in the Term Configuration drawer that \$\\sum \\text{weight\\\_pct} \= 100\\%\$.  
* Assignments are automatically associated with a term where term.start\_date \<= assignment.due\_date \<= term.end\_date (or explicitly overridden by the instructor).

#### **Assignment Status & Penalty Pre-Processor**

Before feeding any score into a calculation engine, normalize the GradeRecord (raw\_score, status, days\_late) against the course's policy rules:

&nbsp;

JavaScript

export function normalizeScore(gradeRecord, assignment, policy) {

&nbsp;&nbsp;if (\!gradeRecord || gradeRecord.status \=== 'exempt') return null; // Excluded from denominator

&nbsp;

&nbsp;&nbsp;if (gradeRecord.status \=== 'missing') {

&nbsp;&nbsp;&nbsp;&nbsp;const floorPct \= policy.missing\_floor\_pct ?? 0; // e.g., 50% minimum-grading scale or 0%

&nbsp;&nbsp;&nbsp;&nbsp;return {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;effectivePct: floorPct,

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;effectivePoints: (floorPct / 100\) \* assignment.max\_score,

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;maxPoints: assignment.max\_score

&nbsp;&nbsp;&nbsp;&nbsp;};

&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;let pct \= (gradeRecord.raw\_score / assignment.max\_score) \* 100;

&nbsp;

&nbsp;&nbsp;if (gradeRecord.status \=== 'late') {

&nbsp;&nbsp;&nbsp;&nbsp;if (policy.late\_mode \=== 'fixed') {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;pct \= Math.max(policy.minimum\_grade\_pct || 0, pct \- policy.late\_deduct\_pct);

&nbsp;&nbsp;&nbsp;&nbsp;} else if (policy.late\_mode \=== 'daily') {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const days \= Math.max(1, gradeRecord.days\_late || 1);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const totalPenalty \= Math.min(policy.max\_late\_cap\_pct || 50, days \* policy.late\_daily\_pct);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;pct \= Math.max(policy.minimum\_grade\_pct || 0, pct \- totalPenalty);

&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;return {

&nbsp;&nbsp;&nbsp;&nbsp;effectivePct: pct,

&nbsp;&nbsp;&nbsp;&nbsp;effectivePoints: (pct / 100\) \* assignment.max\_score,

&nbsp;&nbsp;&nbsp;&nbsp;maxPoints: assignment.max\_score

&nbsp;&nbsp;};

}

&nbsp;

#### **Exact Mathematical Engines (Traditional vs. Standards-Based)**

Implement all five calculation algorithms inside GradebookMathEngine:

&nbsp;

JavaScript

export class GradebookMathEngine {

&nbsp;&nbsp;/\*\*

&nbsp;&nbsp;&nbsp;\* 1\. Traditional Weighted Categories with "Drop Lowest N" support

&nbsp;&nbsp;&nbsp;\* Grade \= sum( CategoryAvg\_k \* CategoryWeight\_k ) / sum( ActiveCategoryWeights )

&nbsp;&nbsp;&nbsp;\*/

&nbsp;&nbsp;static computeTraditionalWeighted(records, assignments, categories) {

&nbsp;&nbsp;&nbsp;&nbsp;let weightedSum \= 0;

&nbsp;&nbsp;&nbsp;&nbsp;let activeWeightTotal \= 0;

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;for (const cat of categories) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const catItems \= assignments

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;.filter(a \=\> a.category\_id \=== cat.id)

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;.map(a \=\> normalizeScore(records.get(a.id), a, cat.policy))

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;.filter(norm \=\> norm \!== null);

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if (catItems.length \=== 0\) continue;

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;// Drop lowest N scores if cat.drop\_lowest \> 0 and enough items exist

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;let keptItems \= \[...catItems\];

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if (cat.drop\_lowest \> 0 && keptItems.length \> cat.drop\_lowest) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;keptItems.sort((a, b) \=\> a.effectivePct \- b.effectivePct);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;keptItems \= keptItems.slice(cat.drop\_lowest);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const earned \= keptItems.reduce((sum, item) \=\> sum \+ item.effectivePoints, 0);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const possible \= keptItems.reduce((sum, item) \=\> sum \+ item.maxPoints, 0);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if (possible \> 0\) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const catPct \= (earned / possible) \* 100;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;weightedSum \+= catPct \* (cat.weight\_pct / 100);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;activeWeightTotal \+= (cat.weight\_pct / 100);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;return activeWeightTotal \> 0 ? Number((weightedSum / activeWeightTotal).toFixed(2)) : null;

&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;/\*\*

&nbsp;&nbsp;&nbsp;\* 2\. SBG: Decaying Average (Prioritizes recent mastery)

&nbsp;&nbsp;&nbsp;\* M\_n \= M\_{n-1} \* (1 \- alpha) \+ S\_n \* alpha (Default alpha \= 0.65)

&nbsp;&nbsp;&nbsp;\* Input scores S\_1 .. S\_n ordered chronologically by assignment date.

&nbsp;&nbsp;&nbsp;\*/

&nbsp;&nbsp;static computeDecayingAverage(chronologicalMasteryScores, alpha \= 0.65) {

&nbsp;&nbsp;&nbsp;&nbsp;if (\!chronologicalMasteryScores || chronologicalMasteryScores.length \=== 0\) return null;

&nbsp;&nbsp;&nbsp;&nbsp;let currentMastery \= chronologicalMasteryScores\[0\];

&nbsp;&nbsp;&nbsp;&nbsp;for (let i \= 1; i \< chronologicalMasteryScores.length; i++) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;currentMastery \= currentMastery \* (1 \- alpha) \+ chronologicalMasteryScores\[i\] \* alpha;

&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;&nbsp;&nbsp;&nbsp;return Number(currentMastery.toFixed(2));

&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;/\*\*

&nbsp;&nbsp;&nbsp;\* 3\. SBG: Marzano Power Law (Predicts current mastery trajectory via Log-Log OLS Regression)

&nbsp;&nbsp;&nbsp;\* Model: S\_t \= a \* (t ^ b)  \==\>  ln(S\_t) \= ln(a) \+ b \* ln(t)

&nbsp;&nbsp;&nbsp;\* where t \= 1, 2, ..., n (assessment ordinal index) and S\_t \> 0\.

&nbsp;&nbsp;&nbsp;\*/

&nbsp;&nbsp;static computeMarzanoPowerLaw(chronologicalMasteryScores) {

&nbsp;&nbsp;&nbsp;&nbsp;const n \= chronologicalMasteryScores.length;

&nbsp;&nbsp;&nbsp;&nbsp;if (n \=== 0\) return null;

&nbsp;&nbsp;&nbsp;&nbsp;if (n \=== 1\) return chronologicalMasteryScores\[0\];

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;let sumX \= 0, sumY \= 0, sumXY \= 0, sumX2 \= 0;

&nbsp;&nbsp;&nbsp;&nbsp;for (let i \= 0; i \< n; i++) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const t \= i \+ 1;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const s \= Math.max(0.1, chronologicalMasteryScores\[i\]); // Guard ln(0)

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const x \= Math.log(t);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const y \= Math.log(s);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;sumX \+= x;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;sumY \+= y;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;sumXY \+= x \* y;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;sumX2 \+= x \* x;

&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;const denom \= n \* sumX2 \- sumX \* sumX;

&nbsp;&nbsp;&nbsp;&nbsp;if (Math.abs(denom) \< 1e-9) return chronologicalMasteryScores\[n \- 1\];

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;const b \= (n \* sumXY \- sumX \* sumY) / denom;

&nbsp;&nbsp;&nbsp;&nbsp;const lnA \= (sumY \- b \* sumX) / n;

&nbsp;&nbsp;&nbsp;&nbsp;const a \= Math.exp(lnA);

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;// Evaluate predicted score at current assessment index t \= n, clamped to \[1.0, 4.0\]

&nbsp;&nbsp;&nbsp;&nbsp;const predicted \= a \* Math.pow(n, b);

&nbsp;&nbsp;&nbsp;&nbsp;return Number(Math.min(4.0, Math.max(1.0, predicted)).toFixed(2));

&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;/\*\*

&nbsp;&nbsp;&nbsp;\* 4\. SBG: Highest Score

&nbsp;&nbsp;&nbsp;\*/

&nbsp;&nbsp;static computeHighestScore(scores) {

&nbsp;&nbsp;&nbsp;&nbsp;return scores.length \> 0 ? Math.max(...scores) : null;

&nbsp;&nbsp;}

&nbsp;

&nbsp;&nbsp;/\*\*

&nbsp;&nbsp;&nbsp;\* 5\. SBG: Mode / Trend Mode (Tie-breaker biased toward latest occurrences)

&nbsp;&nbsp;&nbsp;\*/

&nbsp;&nbsp;static computeTrendMode(chronologicalScores) {

&nbsp;&nbsp;&nbsp;&nbsp;if (chronologicalScores.length \=== 0\) return null;

&nbsp;&nbsp;&nbsp;&nbsp;const freqMap \= new Map();

&nbsp;&nbsp;&nbsp;&nbsp;const lastIndexMap \= new Map();

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;chronologicalScores.forEach((score, idx) \=\> {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const rounded \= Math.round(score \* 2\) / 2; // Bucket by 0.5 increments

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;freqMap.set(rounded, (freqMap.get(rounded) || 0\) \+ 1);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;lastIndexMap.set(rounded, idx);

&nbsp;&nbsp;&nbsp;&nbsp;});

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;let bestScore \= chronologicalScores\[chronologicalScores.length \- 1\];

&nbsp;&nbsp;&nbsp;&nbsp;let maxFreq \= \-1;

&nbsp;&nbsp;&nbsp;&nbsp;let latestIdx \= \-1;

&nbsp;

&nbsp;&nbsp;&nbsp;&nbsp;for (const \[scoreVal, count\] of freqMap.entries()) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;const lastIdx \= lastIndexMap.get(scoreVal);

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;if (count \> maxFreq || (count \=== maxFreq && lastIdx \> latestIdx)) {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;maxFreq \= count;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;latestIdx \= lastIdx;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;bestScore \= scoreVal;

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;&nbsp;&nbsp;&nbsp;return bestScore;

&nbsp;&nbsp;}

}

&nbsp;

#### **SBG-to-Traditional Institutional Conversion Matrix**

Store a configurable lookup matrix mapping overall mastery (1.00–4.00) to institutional percentages and letter grades:

&nbsp;

* 3.50 – 4.00 $\rightarrow$ 95% (A)  
* 3.00 – 3.49 $\rightarrow$ 88% (B+)  
* 2.50 – 2.99 $\rightarrow$ 82% (B-)  
* 2.00 – 2.49 $\rightarrow$ 75% (C)  
* 1.50 – 1.99 $\rightarrow$ 65% (D)  
* \< 1.50 $\rightarrow$ 55% (F)

### **6.2 2D Virtualized Gradebook Grid (src/modules/gradebook/virtual-grid.js) — *Defensive Engineering***

To render **150 students $\times$ 80 assignments (12,000 cells)** at 60 FPS with zero input lag:

&nbsp;

1. **Fixed Geometry Constants:**  
   1. ROW\_HEIGHT \= 40 px; HEADER\_HEIGHT \= 56 px; STUDENT\_COL\_WIDTH \= 220 px; CELL\_WIDTH \= 110 px; OVERSCAN \= 4\.  
2. **2D Windowing Calculation:**  
   1. Outer scroll container has an inner phantom spacer \<div style="width: \${220 \+ assignments.length \* 110}px; height: \${56 \+ students.length \* 40}px;"\>.  
   2. On scroll (throttled via requestAnimationFrame), compute:  
      1. startRow \= Math.max(0, Math.floor(scrollTop / ROW\_HEIGHT) \- OVERSCAN)  
      2. endRow \= Math.min(students.length \- 1, Math.ceil((scrollTop \+ viewportHeight) / ROW\_HEIGHT) \+ OVERSCAN)  
      3. startCol \= Math.max(0, Math.floor(scrollLeft / CELL\_WIDTH) \- OVERSCAN)  
      4. endCol \= Math.min(assignments.length \- 1, Math.ceil((scrollLeft \+ viewportWidth) / CELL\_WIDTH) \+ OVERSCAN)  
   3. Render **only** DOM nodes in \[startRow..endRow\] x \[startCol..endCol\] (typically $\sim 20\times 10=200$ DOM nodes instead of 12,000), positioned via transform: translate3d(\${col \* CELL\_WIDTH}px, \${row \* ROW\_HEIGHT}px, 0).  
   4. Keep the Student Name column (left: 0; position: sticky; z-index: 20\) and Assignment Header row (top: 0; position: sticky; z-index: 20\) pinned during scrolling.  
3. **Single-Input Delegation:**  
   1. Render cells as lightweight \<div\> elements displaying the formatted score and status badge (LATE, MISS, EX).  
   2. Only mount an active \<input type="number"\> or status popover inside the **single currently focused cell**, committing changes to IndexedDB and recomputing only the affected student row's aggregate score on Enter, Tab, or blur.

### **6.3 Multi-Criteria Rubric Designer & Real-Time Scoring Matrix (src/modules/gradebook/rubric-builder.js) — *Implements KB-GRAD-003***

1. **Data Structure:**  
2. JavaScript

{

&nbsp;&nbsp;id: "uuid",

&nbsp;&nbsp;title: "Argumentative Essay Rubric",

&nbsp;&nbsp;tiers: \[

&nbsp;&nbsp;&nbsp;&nbsp;{ id: "t1", label: "Level 1: Novice", default\_points: 10 },

&nbsp;&nbsp;&nbsp;&nbsp;{ id: "t2", label: "Level 2: Proficient", default\_points: 20 },

&nbsp;&nbsp;&nbsp;&nbsp;{ id: "t3", label: "Level 3: Exemplary", default\_points: 30 }

&nbsp;&nbsp;\],

&nbsp;&nbsp;criteria: \[

&nbsp;&nbsp;&nbsp;&nbsp;{

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;id: "c1",

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;name: "Structure & Flow",

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;weight: 1.0,

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;cells: {

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"t1": { points: 10, descriptor: "Incoherent thesis, weak transitions." },

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"t2": { points: 20, descriptor: "Clear organization, solid structure." },

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"t3": { points: 30, descriptor: "Fluid transitions, compelling hook." }

&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;&nbsp;&nbsp;&nbsp;}

&nbsp;&nbsp;\]

}

3. &nbsp;  
4. **Real-Time Weighted Scoring Formula:**  
   1. For each criterion $i\in [1..N]$ with weight ${w}_{i}$, selected cell points ${p}_{i,selected}$, and maximum tier points ${p}_{i,\max\limits_{}}=\max\limits_{j}({p}_{i,j})$:  
   2. $TotalEarned=\sum\limits_{i=1}^{N}\left({{p}_{i,selected}\times {w}_{i}}\right),TotalPossible=\sum\limits_{i=1}^{N}\left({{p}_{i,\max\limits_{}}\times {w}_{i}}\right)$  
   3. Clicking a cell in the interactive grading drawer:  
      1. Toggles the .kb-rubric-active highlight border and sets aria-pressed="true".  
      2. Recomputes Total Earned / Total Possible and percentage/letter grade in real time.  
      3. Appends "\[Criteria Name \- Tier Label\]: Descriptor text" into the student's feedback \<sl-textarea\> (deduplicating or replacing any previous descriptor from the same criterion row).

### **6.4 Individual Student Reports, Batch ZIP Merge & Zero-Server Links (src/modules/gradebook/report-generator.js) — *Implements KB-GRAD-004***

1. **Single-Click Print-Ready PDF (jsPDF \+ jspdf-autotable):**  
   1. Initialize new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' }) (612 x 792 pt).  
   2. Render header block: Course Name, Term Name, Student Full Name, Institutional ID, Generation Timestamp, Cumulative Grade Badge, and Attendance Summary.  
   3. Render **Missing Assignments Alert Box** (high-contrast bordered vector box listing any assignments where status \=== 'missing').  
   4. Invoke doc.autoTable({ startY: 160, head: \[\['Assignment', 'Category', 'Due Date', 'Status', 'Score', 'Standards / Notes'\]\], body: rows, theme: 'grid', headStyles: { fillColor: \[30, 41, 59\] }, pageBreak: 'auto' }).  
   5. Render Teacher Comments block at doc.lastAutoTable.finalY \+ 24\.  
2. **Batch Roster .zip Export (JSZip):**  
   1. Iterate through all students in the active course roster.  
   2. Generate each student's isolated PDF as an ArrayBuffer (doc.output('arraybuffer')).  
   3. Add to JSZip instance: zip.file(\${student.student\_id}\_\${student.full\_name.replace(/\\s+/g, '\_')}\_Report.pdf, pdfBuffer).  
   4. Generate archive via const blob \= await zip.generateAsync({ type: 'blob' }) and download as \${course.name}\_Grade\_Reports\_Batch.zip.  
3. **Zero-Server Encrypted Individual Student URL:**  
   1. Construct an isolated student payload containing **only** that single student's profile, their own assignment grade records, rubric evaluations, and course calculation weights (strictly stripping all classmates' records to guarantee FERPA/student-privacy isolation).  
   2. Pass the payload to CryptoShareEngine.createSharePayload('student\_grade\_report', isolatedStudentData, student.student\_id).  
   3. The resulting link (\#/share?enc=1\&d=...) requires the student's institutional ID (or teacher-assigned passphrase) to decrypt and renders a read-only Student Progress Portal view.

## **7\. Phased Execution Sequence & Verification Protocol for the Agent**

Execute the build strictly in the following 6 sequential phases. Do not proceed to a subsequent phase until the current phase's verification checks pass.

&nbsp;

### **Phase 1: Foundation, App Shell & Core Services (KB-CORE-001 to 004\)**

1. Create index.html, css/app.css, src/main.js, src/router.js, and src/state/store.js.  
2. Implement src/core/storage.js (Dexie schemas, OPFS \>64KB router, quota monitor, private-browsing memory fallback).  
3. Implement src/core/sanitizer.js (DOMPurify \+ Marked \+ KaTeX/Mhchem pipeline).  
4. Implement src/core/validator.js (Zod schemas, PapaParse header normalizer, atomic rollback modal, Exporter factory).  
5. Implement src/core/sync.js (File System Access API 5s debounced auto-sync, fallback downloader, 72h stale backup modal).  
6. Implement src/core/crypto-share.js (PBKDF2 100k iterations \+ AES-GCM binary packer, LZ-String URL builder, 2,048-char guardrail).  
* **Phase 1 Verification Gate:** Verify that saving an object triggers the 5s auto-sync pipeline, corrupt CSV imports display line-level Zod errors without mutating IndexedDB, and encrypting/decrypting a payload via \#/share?enc=1\&d=... succeeds with the correct password and shakes on an invalid password.

### **Phase 2: Flashcards, FSRS & Tower Defense (KB-CARD-001 to 003\)**

1. Implement src/modules/flashcards/sketch-canvas.js (PointerEvents pressure drawing, 20-step undo stack, integer coordinate JSON serialization).  
2. Implement src/modules/flashcards/editor.js (100ms debounced KaTeX/Mhchem preview, TTS configuration).  
3. Implement src/modules/flashcards/fsrs.js and study-player.js (FSRS v4 math, retrievability risk sorting, Space/1-4 keyboard controls, Web Speech synthesis).  
4. Implement src/modules/flashcards/tower-defense.js (60 FPS Canvas loop, procedural vector monsters/towers, 2s turret jam on wrong answer).  
* **Phase 2 Verification Gate:** Render \$\\ce{H2 \+ O2 \-\> H2O}\$, draw a multi-stroke pressure sketch, grade cards with keys 1..4 verifying FSRS stability/difficulty updates, and complete a wave in Tower Defense.

### **Phase 3: Interactive Timeline Engine (KB-TIME-001 to 002\)**

1. Implement src/modules/timeline/canvas-renderer.js (Astronomical day parser, continuous wheel zoom from Hours to Centuries, assignTimelineLanes collision solver, ArrowLeft/ArrowRight/Enter keyboard navigation \+ aria-live announcer).  
2. Implement src/modules/timeline/svg-exporter.js (CSV milestone inference when end\_date is omitted, standalone .svg string serializer).  
* **Phase 3 Verification Gate:** Import a CSV containing overlapping milestones and duration spans, verify zero label overlap across zoom levels, navigate via arrow keys, and open the exported .svg file directly in a new browser tab.

### **Phase 4: Video Assessment Platform (KB-VID-001 to 002\)**

1. Implement src/modules/video/drivers.js (Unified driver for HTML5 \<video\>, YouTube IFrame API, and Vimeo Player SDK).  
2. Implement src/modules/video/interceptor.js (250ms requestAnimationFrame polling loop, $t\pm 0.35s$ pause lock, forward-scrub blocker, question evaluation dialog).  
3. Implement src/modules/video/kiosk-report.js (Student Kiosk view, SHA-256 signed .kbr receipt export/verification, PDF print).  
* **Phase 4 Verification Gate:** Load a video with 2 checkpoints, attempt to scrub past the first checkpoint (confirm snap-back), answer the checkpoint prompt, and generate a .kbr receipt at video completion.

### **Phase 5: Comprehensive Browser Gradebook (KB-GRAD-001 to 004\)**

1. Implement src/modules/gradebook/engine-calc.js (Term weightings summing to 100%, Late/Missing/Exempt normalizer, Traditional Weighted, Decaying Average $\alpha =0.65$, Marzano Power Law ${S}_{t}=a\cdot {t}^{b}$, Highest, and Trend Mode).  
2. Implement src/modules/gradebook/virtual-grid.js (2D virtualized scrolling grid supporting $150\times 80$ cells).  
3. Implement src/modules/gradebook/rubric-builder.js ($N\times M$ weighted rubric designer, click-to-score real-time calculator, feedback auto-append).  
4. Implement src/modules/gradebook/report-generator.js (jsPDF-autotable single report, JSZip batch roster PDF export, and isolated AES-GCM student report URLs).  
* **Phase 5 Verification Gate:** Seed a mock roster of 150 students $\times$ 80 assignments, verify smooth 60 FPS scrolling, toggle between Traditional and Marzano Power Law grading, score a student via a weighted rubric, and export both a batch .zip of PDFs and an encrypted single-student share link.

### **Phase 6: Defensive Engineering Audit & PWA Offline Packaging**

1. Audit every .innerHTML assignment across src/ to confirm it routes through Sanitizer. Test with XSS payload \<img src=x onerror=alert(1)\> inside Markdown/KaTeX fields.  
2. Add manifest.json and sw.js to pre-cache the application shell, CSS, and vendor scripts for offline Chromebook operation.

&nbsp;