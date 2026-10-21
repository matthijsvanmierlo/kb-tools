import { randomBytes } from 'node:crypto';
import { createDatabase } from '../server/relay/db.js';
import { generateToken, hashToken } from '../server/relay/auth.js';

const dbPath = process.env.KB_RELAY_DB || './data/relay.sqlite';
const db = createDatabase(dbPath);

const teacherId = process.argv[2] || `teacher-${randomBytes(4).toString('hex')}`;
const teacherName = process.argv[3] || 'Teacher';
const token = generateToken();
const tokenHash = hashToken(token);

try {
  db.teachers.create({
    id: teacherId,
    name: teacherName,
    tokenHash
  });

  console.log('---------------------------------------------------------');
  console.log(' Teacher account created successfully on relay server');
  console.log('---------------------------------------------------------');
  console.log(` Teacher ID : ${teacherId}`);
  console.log(` Name       : ${teacherName}`);
  console.log(` Database   : ${dbPath}`);
  console.log(` Token      : ${token}`);
  console.log('---------------------------------------------------------');
  const publicUrl = (process.env.KB_RELAY_PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const connectUrl = `${publicUrl}/#/connect?relay=${encodeURIComponent(publicUrl)}&token=${encodeURIComponent(token)}&id=${encodeURIComponent(teacherId)}`;

  console.log(' IMPORTANT: Store this token securely. It will not be shown again.');
  console.log('');
  console.log(' One-click connection link for teacher (scrubs token on open):');
  console.log(` ${connectUrl}`);
  console.log('');
  console.log(' Cloudflare D1 SQL command (if using Cloudflare):');
  console.log(` npx wrangler d1 execute kb-relay-db --remote --command="INSERT OR IGNORE INTO teachers (id, name, token_hash, created_at) VALUES ('${teacherId}', '${teacherName.replace(/'/g, "''")}', '${tokenHash}', '${new Date().toISOString()}');"`);
  console.log('');
  console.log(' Or copy to config.js / settings:');
  console.log(' window.KB_CONFIG = {');
  console.log(`   baseUrl: '${publicUrl}',`);
  console.log(`   token: '${token}',`);
  console.log(`   teacherId: '${teacherId}'`);
  console.log(' };');
  console.log('---------------------------------------------------------');
} catch (err) {
  console.error('Failed to create teacher:', err.message);
  process.exit(1);
}
