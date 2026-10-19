import { storage } from './storage.js';
import { generateUUID } from '../utils/uuid.js';

/**
 * Demo / Sample workspace manager.
 * Provides explicit load, remove, and detection of sample data.
 */

export async function hasDemoData() {
  const loadedAt = await storage.getMetadata('demo_loaded_at');
  if (loadedAt) return true;

  const tables = [
    'gradebook_courses',
    'assignments',
    'flashcards',
    'timelines',
    'video_assessments'
  ];

  for (const t of tables) {
    try {
      const records = await storage.table(t).toArray();
      if (records.some(r => r.is_demo === true)) {
        return true;
      }
    } catch (e) {
      // ignore
    }
  }
  return false;
}

export async function loadDemoWorkspace() {
  const now = new Date().toISOString();

  // 1. AP Chemistry Course
  const apChem = {
    id: generateUUID(),
    name: 'AP Chemistry',
    section: 'Period 2 • Lab Room 304',
    academic_year: '2026-2027',
    color: '#2563eb',
    grading_scale: 'traditional',
    is_demo: true,
    terms: [
      { id: 'term-1', name: 'Fall Semester', start_date: '2026-09-01', end_date: '2026-12-20', weight_pct: 50 },
      { id: 'term-2', name: 'Spring Semester', start_date: '2027-01-10', end_date: '2027-05-30', weight_pct: 50 }
    ],
    categories: [
      { id: 'cat-tests', name: 'Unit Exams', weight_pct: 50, drop_lowest: 1, policy: { late_mode: 'fixed', late_deduct_pct: 10 } },
      { id: 'cat-labs', name: 'Lab Reports', weight_pct: 30, drop_lowest: 0, policy: { late_mode: 'daily', late_daily_pct: 5, max_late_cap_pct: 20 } },
      { id: 'cat-hw', name: 'Homework & Quizzes', weight_pct: 20, drop_lowest: 2, policy: { missing_floor_pct: 50 } }
    ],
    created_at: now,
    updated_at: now
  };

  // 2. World History Course
  const worldHistory = {
    id: generateUUID(),
    name: 'World History',
    section: 'Period 4 • Room 201',
    academic_year: '2026-2027',
    color: '#16a34a',
    grading_scale: 'traditional',
    is_demo: true,
    terms: [
      { id: 'wh-term-1', name: 'Semester 1', start_date: '2026-09-01', end_date: '2027-01-20', weight_pct: 50 }
    ],
    categories: [
      { id: 'wh-cat-projects', name: 'Historical Analyses', weight_pct: 60, drop_lowest: 0, policy: {} },
      { id: 'wh-cat-hw', name: 'Reading & Primary Sources', weight_pct: 40, drop_lowest: 1, policy: {} }
    ],
    created_at: now,
    updated_at: now
  };

  await storage.table('gradebook_courses').bulkPut([apChem, worldHistory]);

  // 3. Students
  const students = [
    { id: generateUUID(), course_id: apChem.id, student_id: 'S101', full_name: 'Emma Watson', given_name: 'Emma', family_name: 'Watson', email: 'ewatson@school.edu', access_code: 'CHEM-4421', notes: 'Excellent lab partner. Preparing for AP exam.', is_demo: true },
    { id: generateUUID(), course_id: apChem.id, student_id: 'S102', full_name: 'Liam Chen', given_name: 'Liam', family_name: 'Chen', email: 'lchen@school.edu', access_code: 'CHEM-9812', notes: 'Excels in thermodynamics calculations.', is_demo: true },
    { id: generateUUID(), course_id: apChem.id, student_id: 'S103', full_name: 'Sophia Patel', given_name: 'Sophia', family_name: 'Patel', email: 'spatel@school.edu', access_code: 'CHEM-3310', notes: 'Needs extra review on balancing redox equations.', is_demo: true },
    { id: generateUUID(), course_id: apChem.id, student_id: 'S104', full_name: 'Noah Rodriguez', given_name: 'Noah', family_name: 'Rodriguez', email: 'nrodriguez@school.edu', access_code: 'CHEM-7744', notes: 'Active classroom contributor.', is_demo: true },
    { id: generateUUID(), course_id: apChem.id, student_id: 'S105', full_name: 'Ava Johnson', given_name: 'Ava', family_name: 'Johnson', email: 'ajohnson@school.edu', access_code: 'CHEM-1109', notes: 'Strong scientific writing skills.', is_demo: true }
  ];
  await storage.table('gradebook_students').bulkPut(students);

  // 4. Rubric
  const sampleRubric = {
    id: generateUUID(),
    course_id: apChem.id,
    title: 'Formal Lab Report Rubric',
    is_demo: true,
    tiers: [
      { id: 't1', label: 'Developing', default_points: 10 },
      { id: 't2', label: 'Proficient', default_points: 20 },
      { id: 't3', label: 'Mastery', default_points: 25 }
    ],
    criteria: [
      {
        id: 'c1',
        name: 'Hypothesis & Method',
        weight: 1.0,
        cells: {
          't1': { points: 10, descriptor: 'Vague hypothesis, incomplete procedure.' },
          't2': { points: 20, descriptor: 'Testable hypothesis, standard procedure.' },
          't3': { points: 25, descriptor: 'Precise hypothesis, rigorous control variables.' }
        }
      },
      {
        id: 'c2',
        name: 'Data & Analysis',
        weight: 1.0,
        cells: {
          't1': { points: 10, descriptor: 'Data recorded with arithmetic errors.' },
          't2': { points: 20, descriptor: 'Accurate tables with units and graphs.' },
          't3': { points: 25, descriptor: 'Thorough statistical error analysis and graphs.' }
        }
      }
    ]
  };
  await storage.table('gradebook_rubrics').put(sampleRubric);

  // 5. Gradebook Assignments
  const sampleGbAssignments = [
    { id: generateUUID(), course_id: apChem.id, term_id: 'term-1', category_id: 'cat-tests', title: 'Atomic Structure Exam', max_score: 100, due_date: '2026-09-25', is_demo: true },
    { id: generateUUID(), course_id: apChem.id, term_id: 'term-1', category_id: 'cat-labs', rubric_id: sampleRubric.id, title: 'Stoichiometry Lab', max_score: 50, due_date: '2026-10-05', is_demo: true },
    { id: generateUUID(), course_id: apChem.id, term_id: 'term-1', category_id: 'cat-hw', title: 'Mole Concept HW', max_score: 20, due_date: '2026-10-10', is_demo: true },
    { id: generateUUID(), course_id: apChem.id, term_id: 'term-1', category_id: 'cat-tests', title: 'Chemical Bonding Exam', max_score: 100, due_date: '2026-10-28', is_demo: true }
  ];
  await storage.table('gradebook_assignments').bulkPut(sampleGbAssignments);

  // 6. Sample Grades
  const sampleGrades = [
    { course_id: apChem.id, student_id: 'S101', assignment_id: sampleGbAssignments[0].id, raw_score: 95, status: 'submitted', is_demo: true },
    { course_id: apChem.id, student_id: 'S101', assignment_id: sampleGbAssignments[1].id, raw_score: 48, status: 'submitted', is_demo: true },
    { course_id: apChem.id, student_id: 'S102', assignment_id: sampleGbAssignments[0].id, raw_score: 82, status: 'submitted', is_demo: true },
    { course_id: apChem.id, student_id: 'S102', assignment_id: sampleGbAssignments[1].id, raw_score: 40, status: 'late', days_late: 2, is_demo: true },
    { course_id: apChem.id, student_id: 'S103', assignment_id: sampleGbAssignments[0].id, raw_score: 74, status: 'submitted', is_demo: true },
    { course_id: apChem.id, student_id: 'S103', assignment_id: sampleGbAssignments[2].id, raw_score: 0, status: 'missing', is_demo: true }
  ];
  await storage.table('gradebook_grades').bulkPut(sampleGrades);

  // 7. Flashcards Deck
  const chemDeck = {
    version: 1,
    id: generateUUID(),
    class_id: null,
    title: 'AP Chemistry • Chemical Foundations & Bonding',
    description: 'Master key equations, thermodynamic laws, and reaction kinetics with spaced repetition.',
    tags: ['Chemistry', 'AP Exam', 'Formulas'],
    updated_at: now,
    is_demo: true,
    cards: [
      {
        id: generateUUID(),
        type: 'text',
        front: { text: 'What is the Henderson-Hasselbalch equation for buffer pH?', ttsLang: 'en-US' },
        back: { text: '$$pH = pK_a + \\log\\left(\\frac{[A^-]}{[HA]}\\right)$$\nRelates solution pH to acid dissociation constant $K_a$.', ttsLang: 'en-US' },
        fsrs: { state: 0, due: now, stability: 0, difficulty: 0, reps: 0, lapses: 0 }
      },
      {
        id: generateUUID(),
        type: 'text',
        front: { text: 'What is the balanced equation for the Haber-Bosch ammonia synthesis?', ttsLang: 'en-US' },
        back: { text: '$$\\ce{N2(g) + 3H2(g) <=> 2NH3(g)} \\quad \\Delta H < 0$$\nExothermic equilibrium reaction.', ttsLang: 'en-US' },
        fsrs: { state: 0, due: now, stability: 0, difficulty: 0, reps: 0, lapses: 0 }
      }
    ]
  };
  await storage.table('flashcards').put(chemDeck);

  // 8. Timeline
  const histTimeline = {
    version: 1,
    id: generateUUID(),
    class_id: null,
    title: 'Ancient & Classical Revolutions',
    description: 'From the Bronze Age collapse to the Roman Empire and Renaissance.',
    updated_at: now,
    is_demo: true,
    events: [
      {
        id: generateUUID(),
        title: 'Assassination of Julius Caesar',
        start_date: '-0044-03-15',
        category: 'Politics',
        description: 'Ides of March marking the transition from Roman Republic to Empire.',
        color: '#dc2626'
      },
      {
        id: generateUUID(),
        title: 'Pax Romana Era',
        start_date: '-0027-01-16',
        end_date: '0180-03-17',
        category: 'Empire',
        description: 'Two centuries of relative peace throughout the Mediterranean Roman realm.',
        color: '#2563eb'
      },
      {
        id: generateUUID(),
        title: 'Martin Luther 95 Theses',
        start_date: '1517-10-31',
        category: 'Reformation',
        description: 'Disputation on the Power of Indulgences sparking the Protestant Reformation.',
        color: '#d97706'
      }
    ]
  };
  await storage.table('timelines').put(histTimeline);

  // 9. Video Assessment
  const chemVideo = {
    version: 1,
    id: generateUUID(),
    class_id: apChem.id,
    title: 'Entropy & Spontaneous Reactions',
    description: 'CrashCourse Chemistry #20 with checkpoints on entropy, the second law, and Gibbs free energy.',
    provider: 'youtube',
    video_source: 'https://www.youtube.com/watch?v=ZsY4WcQOrfk',
    updated_at: now,
    is_demo: true,
    checkpoints: [
      {
        id: generateUUID(),
        timestamp_sec: 60,
        type: 'single_choice',
        prompt_markdown: 'Entropy ($S$) is best described as a measure of…',
        points: 1,
        options: [
          { id: 'opt-1', text: 'How many ways energy and particles can be arranged (dispersal)', is_correct: true, rationale: 'Entropy measures how spread out energy is across possible microstates.' },
          { id: 'opt-2', text: 'The total heat content of a system', is_correct: false, rationale: 'That describes enthalpy ($H$), not entropy.' },
          { id: 'opt-3', text: 'How fast a reaction proceeds', is_correct: false, rationale: 'Reaction rate is kinetics, not thermodynamics.' }
        ]
      },
      {
        id: generateUUID(),
        timestamp_sec: 180,
        type: 'single_choice',
        prompt_markdown: 'What does a negative Gibbs free energy change ($\\Delta G < 0$) indicate?',
        points: 2,
        options: [
          { id: 'opt-1', text: 'The reaction is thermodynamically spontaneous', is_correct: true, rationale: 'Negative ΔG means the process can proceed without outside work.' },
          { id: 'opt-2', text: 'The reaction is strictly endothermic', is_correct: false, rationale: 'ΔH can be positive if TΔS is large enough.' }
        ]
      },
      {
        id: generateUUID(),
        timestamp_sec: 300,
        type: 'open_response',
        prompt_markdown: 'Using $\\Delta G = \\Delta H - T\\Delta S$, explain why ice melts above 0 °C even though melting absorbs heat.',
        keywords: ['entropy', 'temperature', 'TΔS', 'positive', 'spontaneous', 'disorder', 'greater', 'larger'],
        points: 2
      }
    ]
  };
  await storage.table('video_assessments').put(chemVideo);

  // 10. Assignments practice set
  const id8 = () => generateUUID().slice(0, 8);
  const due = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const sampleAssignment = {
    id: generateUUID(),
    version: 1,
    title: 'Stoichiometry & Equilibrium Check-In',
    description: 'Auto-graded practice covering moles, balancing, and Le Chatelier shifts.',
    instructions: 'Answer every question. You will see your score as soon as you submit. Hand in the **submission file** or **submission code** at the end.',
    class_id: apChem.id,
    gradebook: { course_id: apChem.id, category_id: 'cat-hw', column_id: sampleGbAssignments[2].id },
    is_demo: true,
    settings: {
      feedback_mode: 'immediate',
      show_correct_answers: true,
      shuffle_questions: false,
      shuffle_options: true,
      require_access_code: true,
      due_date: due
    },
    questions: [
      {
        id: generateUUID(), type: 'single_choice', points: 1,
        prompt: 'What is the molar mass of water, $\\ce{H2O}$?',
        options: [
          { id: id8(), text: '18.02 g/mol', is_correct: true },
          { id: id8(), text: '16.00 g/mol', is_correct: false },
          { id: id8(), text: '20.02 g/mol', is_correct: false },
          { id: id8(), text: '2.02 g/mol', is_correct: false }
        ],
        explanation: '2 × 1.008 + 16.00 = 18.02 g/mol.'
      },
      {
        id: generateUUID(), type: 'multi_choice', points: 2, scoring: 'partial',
        prompt: 'Which changes shift $\\ce{N2(g) + 3H2(g) <=> 2NH3(g)}$ (exothermic) **toward products**? Select all that apply.',
        options: [
          { id: id8(), text: 'Increasing the pressure', is_correct: true },
          { id: id8(), text: 'Removing NH₃ as it forms', is_correct: true },
          { id: id8(), text: 'Raising the temperature', is_correct: false },
          { id: id8(), text: 'Adding a catalyst', is_correct: false }
        ],
        explanation: 'Fewer gas moles on the product side favour higher pressure; removing product pulls the equilibrium right. Heat is a product, so heating shifts left. Catalysts do not shift equilibrium.'
      },
      {
        id: generateUUID(), type: 'true_false', points: 1, correct: false,
        prompt: 'A catalyst increases the equilibrium constant $K$ of a reaction.',
        explanation: 'A catalyst speeds up both directions equally; $K$ only depends on temperature.'
      }
    ],
    updated_at: now
  };
  await storage.table('assignments').put(sampleAssignment);

  await storage.setMetadata('demo_loaded_at', now);
  return { apChem, worldHistory, sampleAssignment };
}

export async function removeDemoData() {
  const tables = [
    'gradebook_courses',
    'gradebook_students',
    'gradebook_assignments',
    'gradebook_rubrics',
    'assignments',
    'flashcards',
    'timelines',
    'video_assessments'
  ];

  // Also collect demo assignment IDs to clean up submissions
  const demoAssignmentIds = new Set();
  const demoAssignments = await storage.table('assignments').toArray().catch(() => []);
  for (const a of demoAssignments) {
    if (a.is_demo) demoAssignmentIds.add(a.id);
  }

  for (const t of tables) {
    try {
      const records = await storage.table(t).toArray();
      const demoRecords = records.filter(r => r.is_demo === true);
      for (const r of demoRecords) {
        if (r.id) {
          await storage.table(t).delete(r.id);
        }
      }
    } catch (e) {
      console.warn(`Error clearing demo records from ${t}:`, e);
    }
  }

  // Clear demo grades
  try {
    const grades = await storage.table('gradebook_grades').toArray();
    for (const g of grades) {
      if (g.is_demo) {
        const key = [g.student_id, g.assignment_id];
        await storage.table('gradebook_grades').delete(key);
      }
    }
  } catch (e) {
    console.warn('Error clearing demo grades:', e);
  }

  // Clean up submissions for demo assignments or marked is_demo
  try {
    const subs = await storage.table('assignment_submissions').toArray();
    for (const s of subs) {
      if (s.is_demo || demoAssignmentIds.has(s.assignment_id)) {
        if (s.id) {
          await storage.table('assignment_submissions').delete(s.id);
        }
      }
    }
  } catch (e) {
    console.warn('Error clearing demo submissions:', e);
  }

  await storage.setMetadata('demo_loaded_at', null);
}
