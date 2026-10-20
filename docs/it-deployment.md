# KennisBoost for school IT

KennisBoost keeps class data on teachers' own devices, encrypted before it goes anywhere else. There
is no vendor cloud and no central database of student data. This guide covers what IT can set up so
that model is reliable: hosting, managed settings, device policies, backups, the optional school
relay, school-assisted recovery and records requests.

## Contents

1. [Where data lives (for your DPIA)](#where-data-lives)
2. [Hosting the app](#hosting-the-app)
3. [Managed settings: config.json](#managed-settings-configjson)
4. [Device policies](#device-policies)
5. [Backups to the school's cloud](#backups-to-the-schools-cloud)
6. [School relay (optional)](#school-relay-optional)
7. [School-assisted recovery](#school-assisted-recovery)
8. [Records requests, archives and retention](#records-requests-archives-and-retention)

## Where data lives

| Data | Where | Who can read it |
|---|---|---|
| Classes, rosters, grades, materials | Teacher's browser (IndexedDB) | The teacher on that device |
| Backups | A folder/cloud the teacher chooses (encrypted, AES-256-GCM) | The teacher, with their recovery code |
| Student hand-ins in transit | File, QR code, relay or direct Wi-Fi transfer (encrypted to the teacher's or class key) | The teacher (and co-teachers of that class) |
| Sync between a teacher's devices | Relay or backup location (encrypted chunks) | The teacher's linked devices |
| Student drafts (optional) | Relay, encrypted with the student's access code | The student |
| Term archives (optional) | Where the school asks teachers to file them | The teacher; IT too only if `archivesReadableBySchool` is on |

The relay, Google Drive and OneDrive only ever hold ciphertext. The app sends nothing to KennisBoost
or any third party, and loads no third-party scripts (a strict Content Security Policy enforces this).

## Hosting the app

KennisBoost is a static site. Pick one:

- **School web server or VM**: `npm start` (port 8000) sends the full set of security headers.
- **Cloudflare Pages / Netlify**: deploy the repository. The generated `_headers` file sets the CSP
  and clickjacking protection.
- **GitHub Pages**: works, but it can't send headers, so `frame-ancestors` (clickjacking
  protection) is lost.
- **On the school network, together with the relay**: `KB_RELAY_SERVE_APP=1`. One origin, so no CSP
  edits are needed. See `server/relay/README.md` → "Running on a school network".

After changing `index.html`, `config.json` or the enabled cloud providers, run `npm run build`
(CSS, CSP, service-worker file list) and deploy.

## Managed settings: config.json

Put a `config.json` next to `index.html` (start from `config.example.json`). Everyone who can open
the site can read it, so it holds **no secrets**: no tokens, no private keys. OAuth client IDs and
the escrow *public* key are fine.

| Setting | Meaning |
|---|---|
| `school.name`, `school.supportUrl`, `school.itContact` | Shown in exports and help texts |
| `relay.baseUrl` | Pre-fills "Connect to a school server". Teachers still use their own token |
| `cloud.google.clientId`, `cloud.google.hostedDomain` | Enables Google Drive backups (see below) |
| `cloud.microsoft.clientId`, `cloud.microsoft.tenant` | Enables OneDrive backups (see below) |
| `policy.requireAutomaticBackup` | Teachers without automatic backup see "Data at risk" and a prompt each session |
| `policy.backupReminderHours` | When the "no recent backup" reminder appears (default 72) |
| `policy.allowedBackupLocations` | Any of `folder`, `gdrive`, `onedrive`. Manual export is always possible |
| `policy.allowDirectTransfer` | Device-to-device transfers over the local network (default on) |
| `policy.allowCoTeaching` | Sharing a class with another teacher (default on; needs the relay) |
| `policy.studentDraftRoaming` | Students continue drafts on another device via the relay (default on) |
| `escrow.adminPublicKey` | Enables school-assisted recovery (see below) |
| `escrow.label` | How the app names you to teachers, e.g. "the IT department" |
| `escrow.archivesReadableBySchool` | Term archives can be opened with the escrow key, without the teacher |

- **Validation:** the file is validated when the app starts. An invalid file is ignored as a whole
  and never half-applied, and teachers see "School settings were not applied" with the reason under
  **Data safety** in the header.
- **Offline:** the last valid settings stay in effect when a device is offline.
- **CSP:** `npm run csp` reads `config.json` and allows exactly the relay and cloud origins it
  names.

## Device policies

Names below are Chrome policies. Microsoft Edge uses the same names. Set them in the Google Admin
console, Intune (settings catalog / administrative templates) or a Jamf configuration profile.

| Goal | Policy |
|---|---|
| Install KennisBoost as an app for teachers | `WebAppInstallForceList` with your KennisBoost URL. In the Google Admin console: Apps & extensions → Add by URL → Force install |
| Camera for QR hand-in without a prompt | `VideoCaptureAllowedUrls` = your KennisBoost origin |
| Pop-ups for cloud sign-in and printing | `PopupsAllowedForUrls` = your KennisBoost origin |
| Automatic backup to a folder | Don't block the File System Access API (`DefaultFileSystemWriteGuardSetting` must not be 2), or allow your origin in `FileSystemWriteAskForUrls` |

### Keep data on managed devices

This is the most important part. KennisBoost data lives in the browser profile, and some fleet
settings wipe it:

- **ChromeOS ephemeral mode** (`DeviceEphemeralUsersEnabled`, "erase all local user data on
  sign-out") and **Managed Guest Sessions** delete everything at sign-out. Don't use them for
  teachers. On shared student Chromebooks, students can click **"Save Session (.kbsession)"** on the
  Student Hub to download their enrolled courses, progress ledger, and drafts to a USB drive or Google
  Drive, then resume instantly on any shared device via **"Resume Session"**.
- **Clearing site data on exit** (`ClearBrowsingDataOnExitList` with site data, or
  `DefaultCookiesSetting` = "session only") also removes KennisBoost data. Exempt your KennisBoost
  origin, typically via `CookiesAllowedForUrls`, which also covers site storage. Check the result
  under **Data safety → Protected from automatic clean-up**.
- **Installed apps keep their data.** Browsers usually grant persistent storage to installed apps,
  so force-installing (above) also helps here.
- **Inbox Watch Folder (`#/inbox`):** Teachers can select a folder on a local file share or synced drive
  to poll every 4 seconds. Submissions dropped by students or LMS integrations (`.kbsub`, `.kbsub.html`,
  `.kbr`, `.zip`) are staged or auto-imported without requiring internet connectivity.

The app warns teachers when it detects a temporary profile (very small storage quota or private
window). That warning links here.

## Backups to the school's cloud

Every backup is encrypted with the teacher's recovery code before it leaves the browser.

- **Synced folder (no setup):** teachers pick a folder that Google Drive for desktop, OneDrive,
  ChromeOS Files → Google Drive or a network share already syncs. This is the most reliable option:
  backups run silently in the background.
- **Google Drive (direct):** in Google Cloud console, enable the Drive API and create an OAuth client
  of type *Web application*. Add your site as an authorized JavaScript origin and
  `https://<site>/oauth-callback.html` as the redirect URI. The scope used is `drive.file`
  (KennisBoost only sees files it created). Google gives browser apps one-hour tokens, so teachers
  click "Reconnect" about once per session.
- **OneDrive (direct):** in Entra ID → App registrations, create a *Single-page application* with
  the redirect URI `https://<site>/oauth-callback.html`. Add the delegated permission
  `Files.ReadWrite.AppFolder` and grant admin consent. Teachers stay connected for about a day at a
  time.

## School relay (optional)

A small Node.js service that stores only ciphertext. It enables:

- one-click hand-in;
- short links;
- multi-device sync without a shared folder;
- co-teaching;
- student draft roaming;
- public course feeds (`GET /api/feed/:courseId`) with ETag caching.

### Zero-Config Local LAN Relay & mDNS (`teacher-box.local`)

In network-restricted or internet-free school environments, the relay can run directly on a teacher machine, Raspberry Pi, or local lab workstation:

```bash
# Serve both the static web app and the encrypted API on local port 8000
KB_RELAY_SERVE_APP=1 PORT=8000 npm run relay
```

For zero-configuration student discovery across the local subnet:
1. Publish an mDNS hostname (such as `teacher-box.local` or `school-relay.local` via Avahi/Bonjour).
2. Students navigate to `http://teacher-box.local:8000/` or install it as a PWA.
3. If running behind a local TLS reverse proxy (e.g., Caddy):
   ```caddyfile
   teacher-box.local {
       reverse_proxy localhost:8000
   }
   ```
4. WebRTC (`direct-transfer.js`) and Optical QR streams (`KBQ1`) operate completely peer-to-peer even if the relay is disconnected.

It keeps no IP addresses, logs no student identities, and purges expired temporary payloads after `KB_RELAY_RETENTION_DAYS` (default 180).

## School-assisted recovery

Teachers keep a printed recovery kit. If they lose it, school-assisted recovery is the safety net.
IT can't open anyone's data alone:

1. **Create the school key once, on an offline machine:**
   `npm run escrow:keygen -- --out school-escrow-private.json`. Keep the private key file offline:
   an encrypted USB stick in a safe, or a password manager with two-person access.
2. **Publish the public key:** put the printed public key in `config.json` under
   `escrow.adminPublicKey`.
3. **Teachers set a passphrase:** they see "School-assisted recovery not set up" under Data safety
   and choose a passphrase of at least 10 characters. From then on every backup carries the
   recovery secret, encrypted first under that passphrase and then to the school key.
4. **When a teacher has lost their kit:** they send you a backup file. Run
   `npm run escrow:recover -- --key school-escrow-private.json --backup <file>` and give them the
   unlock code it prints. They enter it with their passphrase under Restore backup → "Lost your
   recovery code?", and the app then shows their recovery kit again.

The unlock code is useless without the teacher's passphrase. Long passphrases matter: someone holding
the school key and a backup could otherwise try to guess a short one.

## Records requests, archives and retention

- **Records requests (FERPA inspection, GDPR access or portability):** the teacher holds the data,
  so the teacher runs the export: **Data safety → Student records request**. It exports one student
  or a whole class as a ZIP with `record.json` (everything, machine-readable), CSVs and PDF grade
  reports. Access codes are left out because they are credentials.
- **Term archives:** **Data safety → Archive this term** saves an encrypted archive where the school
  asks, for example a records folder on the school drive.
  - With `escrow.archivesReadableBySchool: true`, IT can open archives without the teacher (for
    instance after they leave): `npm run escrow:recover -- --key … --archive <file> --out ./records`
    writes the snapshot and per-student records.
  - Teachers are told about this before they archive. Their everyday backups stay readable only
    by them.
- **Deleting a student's data:** the teacher removes the student in the gradebook. Linked devices and
  co-teachers receive the deletion through sync. Encrypted backups and archives age out according to
  the folder or cloud retention you configure, and relay copies after `KB_RELAY_RETENTION_DAYS`.
