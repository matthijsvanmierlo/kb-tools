import { storage } from './storage.js';
import { SubmissionCrypto } from './submission-crypto.js';

export const randomSalt = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

export async function computeRosterHash(students = []) {
  if (!Array.isArray(students) || !students.length) return '';
  const sorted = [...students]
    .map(s => `${String(s.student_id || '').toUpperCase()}:${String(s.access_code || '')}`)
    .sort()
    .join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sorted));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

export async function getRosterStatus(item) {
  const courseId = item.gradebook?.course_id || item.class_id;
  if (!courseId) return { courseId: null, course: null, students: [], withCode: [], withoutCode: [] };
  const [course, students] = await Promise.all([
    storage.table('gradebook_courses').get(courseId),
    storage.table('gradebook_students').where('course_id').equals(courseId).toArray().catch(() => [])
  ]);
  return {
    courseId,
    course,
    students,
    withCode: students.filter(s => s.access_code),
    withoutCode: students.filter(s => !s.access_code)
  };
}

export const getTaskRosterStatus = getRosterStatus;

export async function buildRosterChecksAndCards(itemId, roster, requireAccessCode = false) {
  let rosterChecks = null;
  let rosterCards = null;
  if (roster?.withCode?.length) {
    if (requireAccessCode) {
      rosterChecks = {};
      for (const s of roster.withCode) {
        rosterChecks[String(s.student_id).toUpperCase()] = await SubmissionCrypto.accessCodeCheck(itemId, s.student_id, s.access_code);
      }
    }
    rosterCards = {};
    for (const s of roster.withCode) {
      const card = await SubmissionCrypto.buildRosterCard(itemId, s, s.access_code);
      if (card?.tag) {
        rosterCards[card.tag] = card.ct;
      }
    }
  }
  return { rosterChecks, rosterCards };
}

export async function ensureDropBox(item, transport, { cdnActive = false, filesConfig = null } = {}) {
  if (!transport?.capabilities?.collectSubmissions) {
    return item.publish?.relay || null;
  }

  const existing = item.publish?.relay;
  if (existing && existing.drop_id && existing.base_url === transport.baseUrl) {
    const expired = existing.expires_at ? new Date(existing.expires_at).getTime() <= Date.now() : false;
    if (!expired) {
      return existing;
    }
  }

  // Append old drop_id to relay_history so server pulls can drain old boxes
  if (item.publish?.relay?.drop_id) {
    item.publish.relay_history = item.publish.relay_history || [];
    item.publish.relay_history.push({
      drop_id: item.publish.relay.drop_id,
      drop_secret: item.publish.relay.drop_secret,
      base_url: item.publish.relay.base_url,
      retired_at: new Date().toISOString()
    });
  }

  try {
    const expiresAt = new Date(Date.now() + 180 * 86400000).toISOString();
    const drop = await transport.createDrop({
      assignmentId: item.id,
      publishVersion: (item.publish?.version || 0) + 1,
      expiresAt
    });

    const relayInfo = {
      base_url: transport.baseUrl,
      drop_id: drop.dropId,
      drop_secret: drop.dropSecret,
      expires_at: expiresAt
    };

    if (cdnActive) {
      relayInfo.media = {
        enabled: true,
        max_file_bytes: 25 * 1024 * 1024,
        max_files: filesConfig?.max_files || 5,
        accept: filesConfig?.accept || ['.pdf', '.png', '.jpg', '.jpeg', '.zip']
      };
    }

    return relayInfo;
  } catch (err) {
    console.warn('[publish-core] Could not create drop on relay:', err);
    return item.publish?.relay || null;
  }
}

export async function computeContentHash(payload) {
  const clone = JSON.parse(JSON.stringify(payload));
  delete clone.publish_version;
  delete clone.published_at;
  delete clone.salt;
  delete clone.teacher_key;
  delete clone.roster_checks;
  delete clone.roster_cards;
  delete clone.relay;
  delete clone.course_meta;
  const str = JSON.stringify(clone);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}
