import { storage } from '../../core/storage.js';
import { generateUUID } from '../../utils/uuid.js';

/**
 * Demo assignment covering every question type (seeded once when the library is empty).
 */
export async function ensureSampleAssignment() {
  const table = storage.table('assignments');
  if ((await table.count()) > 0) return null;

  const courses = await storage.table('gradebook_courses').toArray().catch(() => []);
  const course = courses.find(c => /chem/i.test(c.name || '')) || courses[0] || null;
  const now = new Date().toISOString();
  const due = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const id8 = () => generateUUID().slice(0, 8);

  const sample = {
    id: generateUUID(),
    version: 1,
    title: 'Stoichiometry & Equilibrium Check-In',
    description: 'Auto-graded practice covering moles, balancing, and Le Chatelier shifts.',
    instructions: 'Answer every question. You will see your score as soon as you submit. Hand in the **submission file** or **submission code** at the end.',
    class_id: course?.id || null,
    gradebook: { course_id: course?.id || null, category_id: course?.categories?.[0]?.id || null, column_id: null },
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
      },
      {
        id: generateUUID(), type: 'short_text', points: 1, accepted: ['Le Chatelier', "Le Chatelier's principle", 'Le Châtelier'], allow_typo: true,
        prompt: 'Whose principle predicts how an equilibrium responds to a disturbance?',
        explanation: "Le Chatelier's principle."
      },
      {
        id: generateUUID(), type: 'numeric', points: 2, target: 2.5, tolerance: 0.02, tolerance_type: 'absolute', unit: 'mol',
        prompt: 'How many moles of $\\ce{O2}$ are in 80.0 g of oxygen gas? (molar mass 32.00 g/mol)',
        explanation: '80.0 g ÷ 32.00 g/mol = 2.50 mol.'
      },
      {
        id: generateUUID(), type: 'fill_blank', points: 2, scoring: 'partial',
        prompt: 'Balance the equation: [[blank]] H₂ + O₂ → [[blank]] H₂O',
        blanks: [{ accepted: ['2'] }, { accepted: ['2'] }],
        explanation: '2 H₂ + O₂ → 2 H₂O'
      },
      {
        id: generateUUID(), type: 'ordering', points: 2, scoring: 'partial',
        prompt: 'Put the steps of a mass-to-mass stoichiometry calculation in order.',
        items: [
          { id: id8(), text: 'Convert grams of A to moles of A' },
          { id: id8(), text: 'Use the mole ratio to get moles of B' },
          { id: id8(), text: 'Convert moles of B to grams of B' },
          { id: id8(), text: 'Round to the correct significant figures' }
        ]
      },
      {
        id: generateUUID(), type: 'matching', points: 3, scoring: 'partial',
        prompt: 'Match each quantity to its SI unit.',
        pairs: [
          { id: id8(), left: 'Amount of substance', right: 'mole (mol)' },
          { id: id8(), left: 'Molar mass', right: 'g/mol' },
          { id: id8(), left: 'Concentration', right: 'mol/L' }
        ],
        distractors: ['kg·m/s']
      },
      {
        id: generateUUID(), type: 'long_text', points: 4,
        prompt: 'Explain, using collision theory, why increasing temperature increases reaction rate.',
        rubric_hint: 'Full credit: more frequent collisions AND a larger fraction of collisions exceeding the activation energy.'
      }
    ],
    publish: null,
    created_at: now,
    updated_at: now
  };

  await table.put(sample);
  return sample;
}
