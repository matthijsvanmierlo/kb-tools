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
  console.log(' IMPORTANT: Store this token securely. It will not be shown again.');
  console.log(' To connect your browser client, copy this to config.js:');
  console.log('');
  console.log(' window.KB_CONFIG = {');
  console.log(`   baseUrl: 'http://localhost:3000',`);
  console.log(`   token: '${token}',`);
  console.log(`   teacherId: '${teacherId}'`);
  console.log(' };');
  console.log('---------------------------------------------------------');
} catch (err) {
  console.error('Failed to create teacher:', err.message);
  process.exit(1);
}
