/**
 * Pure helper for computing Home dashboard statistics, setup checklist, and attention items.
 */

export function computeHomeStats({
  courses = [],
  students = [],
  assignments = [],
  submissions = [],
  videos = [],
  metadata = {},
  quota = null,
  now = new Date()
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();

  // 1. Setup Checklist
  const nonDemoCourses = courses.filter(c => !c.is_demo && !c.archived_at);
  const nonDemoStudents = students.filter(s => !s.is_demo);

  const hasClass = nonDemoCourses.length > 0;
  const hasStudents = nonDemoStudents.length > 0;
  const hasAccessCodes = hasStudents && nonDemoStudents.every(s => Boolean(s.access_code));
  const hasPublished = assignments.some(a => !a.is_demo && a.publish) ||
                       videos.some(v => !v.is_demo && v.shared_at);
  const hasBackup = Boolean(metadata?.last_manual_export_timestamp);
  // Browsers without the File System Access API can only make manual backups
  const hasAutomaticBackup = Boolean(metadata?.autosync_configured)
    || (metadata?.autosync_supported === false && hasBackup);
  const hasRecoveryKit = Boolean(metadata?.recovery_kit_saved);

  const checklistItems = [
    {
      id: 'create_class',
      label: 'Create a class',
      completed: hasClass,
      actionRoute: '#/gradebook',
      actionLabel: 'Set up class'
    },
    {
      id: 'add_students',
      label: 'Add your students',
      completed: hasStudents,
      actionRoute: '#/gradebook?view=roster',
      actionLabel: 'Add students'
    },
    {
      id: 'access_codes',
      label: 'Generate access codes',
      completed: hasAccessCodes,
      actionRoute: '#/gradebook',
      actionLabel: 'Generate codes'
    },
    {
      id: 'publish_work',
      label: 'Publish an assessment or video',
      completed: hasPublished,
      actionRoute: '#/assessments',
      actionLabel: 'Create assessment'
    },
    {
      id: 'make_backup',
      label: metadata?.autosync_supported === false ? 'Make an encrypted backup' : 'Turn on automatic encrypted backup',
      completed: hasAutomaticBackup,
      actionRoute: '#backup',
      actionLabel: metadata?.autosync_supported === false ? 'Backup now' : 'Choose location'
    },
    {
      id: 'recovery_kit',
      label: 'Save your recovery kit',
      completed: hasRecoveryKit,
      actionRoute: '#recovery-kit',
      actionLabel: 'Show kit'
    }
  ];

  const checklistDismissed = Boolean(metadata?.setup_checklist_dismissed_at);
  const checklistAllDone = checklistItems.every(i => i.completed);
  const showChecklist = !checklistDismissed && !checklistAllDone;

  // 2. Needs Attention Items
  const attentionItems = [];

  // A. Submissions to review
  const unsyncedSubs = submissions.filter(s => s.is_latest !== false && !s.synced_at);
  if (unsyncedSubs.length > 0) {
    // Group by assignment
    const grouped = new Map();
    for (const sub of unsyncedSubs) {
      const arr = grouped.get(sub.assignment_id) || [];
      arr.push(sub);
      grouped.set(sub.assignment_id, arr);
    }

    for (const [assignmentId, subs] of grouped.entries()) {
      const asgn = assignments.find(a => a.id === assignmentId);
      const title = asgn?.title || 'Assessment';
      attentionItems.push({
        type: 'submissions_to_review',
        badge: 'Review',
        badgeVariant: 'warning',
        text: `${subs.length} submission(s) to review for "${title}"`,
        link: `#/assessments/submissions?id=${assignmentId}`
      });
    }
  }

  // B. Students without access codes in classes
  for (const course of nonDemoCourses) {
    const classStudents = nonDemoStudents.filter(s => s.course_id === course.id);
    const missingCodes = classStudents.filter(s => !s.access_code);
    if (missingCodes.length > 0) {
      attentionItems.push({
        type: 'missing_access_codes',
        badge: 'Security',
        badgeVariant: 'danger',
        text: `${missingCodes.length} student(s) without access codes in ${course.name}`,
        link: `#/gradebook`
      });
    }
  }

  // C. Stale backup
  const lastBackupStr = metadata?.last_manual_export_timestamp;
  if (lastBackupStr) {
    const daysSince = Math.floor((nowMs - new Date(lastBackupStr).getTime()) / (1000 * 86400));
    if (daysSince > 3) {
      attentionItems.push({
        type: 'stale_backup',
        badge: 'Backup',
        badgeVariant: 'warning',
        text: `Backup is ${daysSince} days old. Save a copy of your workspace.`,
        action: 'backup'
      });
    }
  } else if (courses.length > 0) {
    attentionItems.push({
      type: 'no_backup',
      badge: 'Backup',
      badgeVariant: 'warning',
      text: 'No manual backup recorded. Save a copy of your workspace.',
      action: 'backup'
    });
  }

  // D. Upcoming assignments due in the next 7 days
  const todayStr = nowDate.toISOString().slice(0, 10);
  const sevenDaysAheadStr = new Date(nowMs + 7 * 86400000).toISOString().slice(0, 10);

  for (const asgn of assignments) {
    const due = asgn.settings?.due_date;
    if (due && due >= todayStr && due <= sevenDaysAheadStr && asgn.class_id) {
      const course = courses.find(c => c.id === asgn.class_id);
      const rosterCount = students.filter(s => s.course_id === asgn.class_id).length;
      const subCount = submissions.filter(s => s.assignment_id === asgn.id && s.is_latest !== false).length;
      attentionItems.push({
        type: 'upcoming_due',
        badge: 'Due Soon',
        badgeVariant: 'neutral',
        text: `"${asgn.title}" due ${due}: ${subCount}/${rosterCount} handed in`,
        link: `#/assessments/submissions?id=${asgn.id}`
      });
    }
  }

  // E. Storage quota warning
  if (quota && quota.ratio > 0.8) {
    const pct = Math.round(quota.ratio * 100);
    attentionItems.push({
      type: 'storage_quota',
      badge: 'Storage',
      badgeVariant: 'danger',
      text: `Storage is ${pct}% used (${quota.usageMB} MB of ${quota.quotaMB} MB)`,
      action: 'storage_info'
    });
  }

  return {
    checklistItems,
    checklistAllDone,
    checklistDismissed,
    showChecklist,
    attentionItems
  };
}
