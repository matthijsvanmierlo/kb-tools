// Optional: pre-configure a school relay server for a managed deployment.
// 1. Copy this file to config.js (git-ignored).
// 2. Add <script src="config.js"></script> before src/main.js in index.html.
// 3. If the relay is on another origin, allow it in the CSP: `KB_RELAY_ORIGIN=<origin> npm start`
//    for the bundled server, or `KB_RELAY_ORIGIN=<origin> npm run csp` before a static deploy.
// Anything in this file is public to whoever can load the site, so prefer the in-app
// "Connect to a school server" dialog for teacher tokens.
window.KB_CONFIG = {
  baseUrl: 'http://localhost:3000',
  token: 'YOUR_TEACHER_TOKEN',
  teacherId: 'T1'
};
