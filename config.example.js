// Optional: managed deployment settings.
// 1. Copy this file to config.js (git-ignored).
// 2. Add <script src="config.js"></script> before src/main.js in index.html.
// 3. Allow the extra origins in the CSP, for the bundled server (`... npm start`) or before a
//    static deploy (`... npm run csp`):
//      KB_RELAY_ORIGIN=<relay origin>           if the relay is on another origin
//      KB_CLOUD_PROVIDERS=google,microsoft       for the cloud backup providers you enable
// Anything in this file is public to whoever can load the site, so prefer the in-app
// "Connect to a school server" dialog for teacher tokens. OAuth client IDs are not secrets.
window.KB_CONFIG = {
  // School relay server (short links, server hand-in)
  baseUrl: 'http://localhost:3000',
  token: 'YOUR_TEACHER_TOKEN',
  teacherId: 'T1',

  // Cloud backup locations. Backups are encrypted before upload, so the provider only ever
  // stores ciphertext. Leave a provider out to hide it. Teachers can always back up to a synced
  // folder (Drive for desktop, OneDrive, ChromeOS Files) without any of this.
  //
  // In both consoles, register this redirect URI exactly:
  //   https://<your KennisBoost site>/oauth-callback.html
  cloud: {
    // Google Cloud console → APIs & Services: enable the Google Drive API, create an OAuth client
    // of type "Web application", add your site under "Authorized JavaScript origins" and the
    // redirect URI above. Scope used: drive.file (only files KennisBoost created).
    google: {
      clientId: 'YOUR_CLIENT_ID.apps.googleusercontent.com',
      hostedDomain: 'myschool.edu' // optional: pre-select school accounts
    },
    // Microsoft Entra admin center → App registrations: platform "Single-page application" with
    // the redirect URI above; API permission Microsoft Graph → Files.ReadWrite.AppFolder
    // (delegated). Grant admin consent to spare teachers the consent screen.
    microsoft: {
      clientId: '00000000-0000-0000-0000-000000000000',
      tenant: 'organizations' // or your tenant ID to allow only your school's accounts
    }
  }
};
