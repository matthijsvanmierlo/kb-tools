import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { ConfirmDialog } from '../../utils/dialogs.js';
import { generateUUID } from '../../utils/uuid.js';
import { RubricDesigner } from '../gradebook/rubric-builder.js';

const esc = (v) => Sanitizer.escapeHTML(String(v ?? ''));

export const RUBRIC_TEMPLATES = [
  {
    id: 'tpl-sbg-4pt',
    name: '4-Level Standards Mastery',
    description: 'Clean 4 / 3 / 2 / 1 proficiency rubric ideal for Standards-Based Grading.',
    scoring_mode: 'proficiency',
    tiers: [
      { label: 'Exemplary (4)', default_points: 4 },
      { label: 'Proficient (3)', default_points: 3 },
      { label: 'Developing (2)', default_points: 2 },
      { label: 'Beginning (1)', default_points: 1 }
    ],
    criteria: [
      { name: 'Conceptual Understanding', weight: 1, descriptors: ['Applies concepts accurately to novel situations.', 'Demonstrates solid understanding of core concepts.', 'Shows partial understanding with minor misconceptions.', 'Requires significant support to grasp core concepts.'] },
      { name: 'Evidence & Reasoning', weight: 1, descriptors: ['Provides thorough, compelling evidence and clear reasoning.', 'Supports claims with relevant evidence and sound reasoning.', 'Provides limited evidence or incomplete reasoning.', 'Claims lack supporting evidence or logical connection.'] },
      { name: 'Communication & Precision', weight: 1, descriptors: ['Clear, precise vocabulary and well-organized presentation.', 'Generally clear with appropriate domain terminology.', 'Occasionally unclear or missing key terminology.', 'Difficult to follow; imprecise terminology.'] }
    ]
  },
  {
    id: 'tpl-essay',
    name: 'Analytical Essay / Writing',
    description: '4-criterion writing rubric covering Thesis, Evidence, Analysis, and Conventions.',
    scoring_mode: 'points',
    tiers: [
      { label: 'Exemplary', default_points: 4 },
      { label: 'Proficient', default_points: 3 },
      { label: 'Developing', default_points: 2 },
      { label: 'Needs Work', default_points: 1 }
    ],
    criteria: [
      { name: 'Thesis & Focus', weight: 1.5, descriptors: ['Nuanced, arguable thesis sustained throughout.', 'Clear, arguable thesis that guides the essay.', 'Thesis is present but broad or partially developed.', 'Missing or unclear central claim.'] },
      { name: 'Textual Evidence', weight: 1.5, descriptors: ['Well-chosen, seamlessly integrated quotes/data.', 'Relevant evidence accurately cited.', 'Evidence is sparse or loosely connected.', 'Little to no relevant evidence provided.'] },
      { name: 'Analysis & Reasoning', weight: 2.0, descriptors: ['Insightful explanation linking evidence to thesis.', 'Clear explanation of how evidence supports claims.', 'Summarizes evidence rather than analyzing it.', 'Minimal or off-topic commentary.'] },
      { name: 'Organization & Conventions', weight: 1.0, descriptors: ['Smooth transitions and virtually error-free prose.', 'Logical structure; minor mechanical errors.', 'Uneven organization; errors occasionally distract.', 'Disorganized; frequent errors impede meaning.'] }
    ]
  },
  {
    id: 'tpl-cer-lab',
    name: 'STEM Lab Report & CER',
    description: 'Claim-Evidence-Reasoning + Experimental Design & Data Analysis.',
    scoring_mode: 'points',
    tiers: [
      { label: 'Exceeds', default_points: 4 },
      { label: 'Meets', default_points: 3 },
      { label: 'Approaching', default_points: 2 },
      { label: 'Beginning', default_points: 1 }
    ],
    criteria: [
      { name: 'Claim', weight: 1.0, descriptors: ['Accurate, complete, and directly answers the research question.', 'Accurate claim answering the research question.', 'Partially accurate or overly broad claim.', 'Claim is missing or contradicted by data.'] },
      { name: 'Evidence & Data', weight: 1.5, descriptors: ['Appropriate, sufficient quantitative & qualitative data with units.', 'Relevant data included with minor omissions.', 'Incomplete data or missing units/labels.', 'Insufficient or inaccurate data.'] },
      { name: 'Scientific Reasoning', weight: 1.5, descriptors: ['Explicitly connects data to scientific principles & error analysis.', 'Connects evidence to claim using scientific principles.', 'Weak connection between data and scientific principles.', 'No scientific reasoning provided.'] }
    ]
  },
  {
    id: 'tpl-cs-project',
    name: 'Programming & CS Project',
    description: 'Evaluates Functional Correctness, Edge Cases, Code Quality, and Documentation.',
    scoring_mode: 'points',
    tiers: [
      { label: 'Exemplary', default_points: 4 },
      { label: 'Proficient', default_points: 3 },
      { label: 'Developing', default_points: 2 },
      { label: 'Incomplete', default_points: 1 }
    ],
    criteria: [
      { name: 'Correctness & Requirements', weight: 2.0, descriptors: ['All requirements met; handles all edge cases gracefully.', 'Core requirements met; minor edge-case issues.', 'Partially functional; fails on several test cases.', 'Does not run or misses core requirements.'] },
      { name: 'Code Structure & Readability', weight: 1.0, descriptors: ['Modular functions, clean naming, zero duplication.', 'Well-organized with clear variable/function names.', 'Some long functions or unclear naming.', 'Monolithic or difficult to read.'] },
      { name: 'Documentation & Testing', weight: 1.0, descriptors: ['Clear comments, docstrings, and comprehensive test cases.', 'Adequate comments and basic tests included.', 'Minimal comments or missing tests.', 'No documentation or tests.'] }
    ]
  },
  {
    id: 'tpl-presentation',
    name: 'Oral Presentation / Defense',
    description: 'Assesses Content Mastery, Visual Aids, Delivery, and Q&A.',
    scoring_mode: 'points',
    tiers: [
      { label: 'Distinguished', default_points: 4 },
      { label: 'Proficient', default_points: 3 },
      { label: 'Developing', default_points: 2 },
      { label: 'Emerging', default_points: 1 }
    ],
    criteria: [
      { name: 'Content Mastery & Clarity', weight: 1.5, descriptors: ['Deep command of topic; explains complex ideas clearly.', 'Accurate content presented in a logical sequence.', 'Some inaccuracies or gaps in explanation.', 'Unclear or inaccurate information.'] },
      { name: 'Visuals & Pacing', weight: 1.0, descriptors: ['Engaging, uncluttered slides; ideal pacing and eye contact.', 'Clean visuals; steady pace and clear voice.', 'Text-heavy slides or rushed/uneven pacing.', 'Visuals missing or hard to follow.'] },
      { name: 'Q&A Response', weight: 1.0, descriptors: ['Answers questions thoughtfully with supporting evidence.', 'Answers most questions accurately.', 'Struggles to elaborate beyond prepared notes.', 'Unable to address audience questions.'] }
    ]
  },
  {
    id: 'tpl-single-point',
    name: 'Single-Point Feedback Rubric',
    description: 'Focuses on clear target expectations with room for growth and exceeds notes.',
    scoring_mode: 'single_point',
    tiers: [
      { label: 'Exceeds Target', default_points: 4 },
      { label: 'Meets Target', default_points: 3 },
      { label: 'Not Yet / Growing', default_points: 1 }
    ],
    criteria: [
      { name: 'Core Learning Target', weight: 1.0, descriptors: ['Goes beyond target with original insight.', 'Demonstrates the expected skill/knowledge independently.', 'Needs revision or guided practice to reach target.'] },
      { name: 'Craft & Revision', weight: 1.0, descriptors: ['Polished work incorporating feedback thoughtfully.', 'Meets quality and formatting expectations.', 'Incomplete or needs further revision.'] }
    ]
  }
];

/**
 * Instantiate a full rubric object from a starter template.
 */
export function buildRubricFromTemplate(templateId, { courseId = null, title = null } = {}) {
  const tpl = RUBRIC_TEMPLATES.find(t => t.id === templateId) || RUBRIC_TEMPLATES[0];
  const tiers = tpl.tiers.map(t => ({
    id: generateUUID(),
    label: t.label,
    default_points: t.default_points
  }));
  const criteria = tpl.criteria.map(c => {
    const cells = {};
    tiers.forEach((tier, idx) => {
      cells[tier.id] = {
        points: tier.default_points,
        descriptor: c.descriptors?.[idx] || ''
      };
    });
    return {
      id: generateUUID(),
      name: c.name,
      weight: c.weight ?? 1.0,
      standard_id: null,
      cells
    };
  });

  return {
    id: generateUUID(),
    course_id: courseId || null,
    title: title || tpl.name,
    scoring_mode: tpl.scoring_mode || 'points',
    tiers,
    criteria,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

export async function renderRubricStudio(params = {}, router, container) {
  let scopeFilter = params?.courseId || 'all'; // 'all' | 'shared' | <courseId>
  let searchQuery = '';

  const render = async () => {
    const [rubrics, courses, tasks, assignments, gbAssignments] = await Promise.all([
      storage.table('gradebook_rubrics').toArray().catch(() => []),
      storage.table('gradebook_courses').toArray().catch(() => []),
      storage.table('tasks').toArray().catch(() => []),
      storage.table('assignments').toArray().catch(() => []),
      storage.table('gradebook_assignments').toArray().catch(() => [])
    ]);

    const courseById = new Map(courses.map(c => [c.id, c]));

    // Compute usage counts per rubric
    const usageCount = new Map();
    const bump = (rid) => { if (rid) usageCount.set(rid, (usageCount.get(rid) || 0) + 1); };
    tasks.forEach(t => bump(t.grading?.rubric_id));
    assignments.forEach(a => {
      bump(a.rubric_id);
      (a.questions || []).forEach(q => bump(q.rubric_id));
    });
    gbAssignments.forEach(ga => bump(ga.rubric_id));

    const filtered = rubrics
      .filter(r => {
        if (scopeFilter === 'shared') return !r.course_id;
        if (scopeFilter !== 'all') return r.course_id === scopeFilter;
        return true;
      })
      .filter(r => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        const titleMatch = (r.title || '').toLowerCase().includes(q);
        const critMatch = (r.criteria || []).some(c => (c.name || '').toLowerCase().includes(q));
        return titleMatch || critMatch;
      })
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));

    container.innerHTML = `
      <div class="max-w-7xl mx-auto space-y-6 pb-16">
        <!-- Header -->
        <div class="bg-white rounded-2xl border border-slate-200 p-5 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 class="text-xl font-bold text-slate-900 flex items-center gap-2">
              <sl-icon name="grid-3x3" class="text-indigo-600"></sl-icon> Rubric Studio
            </h1>
            <p class="text-xs text-slate-500 mt-0.5">Design reusable rubrics outside the gradebook and attach them to Assignments, Assessments, and Standards.</p>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <input type="file" id="rubric-import-file" accept=".json" class="hidden" />
            <sl-button size="small" variant="default" id="btn-import-rubric">
              <sl-icon slot="prefix" name="upload"></sl-icon> Import JSON
            </sl-button>
            <sl-button size="small" variant="primary" id="btn-new-blank-rubric">
              <sl-icon slot="prefix" name="plus-lg"></sl-icon> New Rubric
            </sl-button>
          </div>
        </div>

        <!-- Starter Templates Gallery -->
        <section class="space-y-3">
          <div class="flex items-center justify-between">
            <h2 class="text-xs font-bold uppercase tracking-wider text-slate-500">Start from a Template</h2>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            ${RUBRIC_TEMPLATES.map(tpl => `
              <button type="button" class="btn-use-template text-left bg-white hover:bg-indigo-50/40 border border-slate-200 hover:border-indigo-300 rounded-xl p-4 transition-all shadow-2xs group" data-tpl-id="${esc(tpl.id)}">
                <div class="flex items-center justify-between gap-2">
                  <span class="font-semibold text-sm text-slate-900 group-hover:text-indigo-700">${esc(tpl.name)}</span>
                  <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 uppercase">${esc(tpl.scoring_mode === 'proficiency' ? 'SBG' : tpl.scoring_mode === 'single_point' ? 'Single-Pt' : 'Points')}</span>
                </div>
                <p class="text-xs text-slate-500 mt-1 line-clamp-2">${esc(tpl.description)}</p>
                <div class="text-[11px] text-indigo-600 font-medium mt-2 flex items-center gap-1">
                  <sl-icon name="plus-circle"></sl-icon> Use template (${tpl.criteria.length} criteria × ${tpl.tiers.length} tiers)
                </div>
              </button>
            `).join('')}
          </div>
        </section>

        <!-- Library Filters & List -->
        <section class="space-y-4">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="flex items-center gap-2 flex-wrap">
              <h2 class="text-sm font-bold text-slate-800 mr-2">Your Rubrics (${filtered.length})</h2>
              <sl-select size="small" id="rubric-scope-filter" value="${esc(scopeFilter)}" class="w-48">
                <sl-option value="all">All Rubrics</sl-option>
                <sl-option value="shared">Shared (All Classes)</sl-option>
                ${courses.map(c => `<sl-option value="${esc(c.id)}">${esc(c.name)}</sl-option>`).join('')}
              </sl-select>
            </div>
            <sl-input size="small" id="rubric-search" placeholder="Search rubrics or criteria..." value="${esc(searchQuery)}" clearable class="w-full sm:w-64">
              <sl-icon slot="prefix" name="search"></sl-icon>
            </sl-input>
          </div>

          ${filtered.length === 0 ? `
            <div class="bg-white rounded-2xl border border-dashed border-slate-300 p-10 text-center space-y-2">
              <sl-icon name="grid-3x3" class="text-3xl text-slate-300"></sl-icon>
              <p class="text-sm font-semibold text-slate-700">No rubrics match your filter</p>
              <p class="text-xs text-slate-500">Pick a starter template above or click "New Rubric" to build one.</p>
            </div>
          ` : `
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              ${filtered.map(r => {
                const course = r.course_id ? courseById.get(r.course_id) : null;
                const uses = usageCount.get(r.id) || 0;
                const alignedCount = (r.criteria || []).filter(c => c.standard_id).length;
                return `
                  <article class="bg-white rounded-2xl border border-slate-200 p-4 shadow-2xs flex flex-col justify-between gap-3">
                    <div class="space-y-2">
                      <div class="flex items-start justify-between gap-2">
                        <h3 class="font-bold text-slate-900 text-sm leading-snug">${esc(r.title || 'Untitled Rubric')}</h3>
                        <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${course ? 'bg-blue-50 text-blue-700' : 'bg-emerald-50 text-emerald-700'}">
                          ${course ? esc(course.name) : 'Shared'}
                        </span>
                      </div>
                      <div class="flex flex-wrap gap-1.5 text-[11px] text-slate-500">
                        <span>${(r.criteria || []).length} criteria</span>
                        <span>·</span>
                        <span>${(r.tiers || []).length} tiers</span>
                        ${alignedCount ? `<span>·</span><span class="text-indigo-600 font-medium">${alignedCount} standard-linked</span>` : ''}
                        ${uses ? `<span>·</span><span class="text-slate-700 font-medium">Used in ${uses} item${uses === 1 ? '' : 's'}</span>` : ''}
                      </div>
                      <div class="flex flex-wrap gap-1 pt-1">
                        ${(r.criteria || []).slice(0, 4).map(c => `<span class="text-[10px] px-2 py-0.5 rounded bg-slate-100 text-slate-600 truncate max-w-[140px]">${esc(c.name)}</span>`).join('')}
                        ${(r.criteria || []).length > 4 ? `<span class="text-[10px] text-slate-400">+${r.criteria.length - 4} more</span>` : ''}
                      </div>
                    </div>
                    <div class="flex items-center justify-between pt-2 border-t border-slate-100">
                      <div class="flex items-center gap-1">
                        <sl-button size="small" variant="primary" outline class="btn-edit-rubric" data-id="${esc(r.id)}">
                          <sl-icon slot="prefix" name="pencil"></sl-icon> Edit
                        </sl-button>
                        <sl-tooltip content="${r.course_id ? 'Make Shared across all classes' : 'Already Shared'}">
                          <sl-button size="small" variant="default" class="btn-share-rubric" data-id="${esc(r.id)}" ${!r.course_id ? 'disabled' : ''}>
                            <sl-icon name="globe"></sl-icon>
                          </sl-button>
                        </sl-tooltip>
                      </div>
                      <div class="flex items-center gap-0.5">
                        <sl-tooltip content="Duplicate">
                          <button type="button" class="kb-icon-btn btn-dup-rubric" data-id="${esc(r.id)}" aria-label="Duplicate"><sl-icon name="copy"></sl-icon></button>
                        </sl-tooltip>
                        <sl-tooltip content="Export JSON">
                          <button type="button" class="kb-icon-btn btn-exp-rubric" data-id="${esc(r.id)}" aria-label="Export"><sl-icon name="download"></sl-icon></button>
                        </sl-tooltip>
                        <sl-tooltip content="Delete">
                          <button type="button" class="kb-icon-btn hover:!text-red-600 btn-del-rubric" data-id="${esc(r.id)}" aria-label="Delete"><sl-icon name="trash"></sl-icon></button>
                        </sl-tooltip>
                      </div>
                    </div>
                  </article>
                `;
              }).join('')}
            </div>
          `}
        </section>
      </div>
    `;

    // Bind events
    container.querySelector('#rubric-scope-filter')?.addEventListener('sl-change', (e) => {
      scopeFilter = e.target.value || 'all';
      render();
    });

    container.querySelector('#rubric-search')?.addEventListener('sl-input', (e) => {
      searchQuery = e.target.value || '';
      render();
    });

    container.querySelector('#btn-new-blank-rubric')?.addEventListener('click', async () => {
      const targetCourseId = (scopeFilter !== 'all' && scopeFilter !== 'shared') ? scopeFilter : null;
      const saved = await RubricDesigner.create({ courseId: targetCourseId, initialTitle: 'New Rubric' });
      if (saved) render();
    });

    container.querySelectorAll('.btn-use-template').forEach(btn => {
      btn.addEventListener('click', async () => {
        const targetCourseId = (scopeFilter !== 'all' && scopeFilter !== 'shared') ? scopeFilter : null;
        const tpl = buildRubricFromTemplate(btn.dataset.tplId, { courseId: targetCourseId });
        const saved = await RubricDesigner.edit(tpl);
        if (saved) render();
      });
    });

    container.querySelectorAll('.btn-edit-rubric').forEach(btn => {
      btn.addEventListener('click', async () => {
        const r = rubrics.find(x => x.id === btn.dataset.id);
        if (!r) return;
        const saved = await RubricDesigner.edit(r);
        if (saved) render();
      });
    });

    container.querySelectorAll('.btn-share-rubric').forEach(btn => {
      btn.addEventListener('click', async () => {
        const r = rubrics.find(x => x.id === btn.dataset.id);
        if (!r) return;
        r.course_id = null;
        r.updated_at = new Date().toISOString();
        await storage.table('gradebook_rubrics').put(r);
        toast.success(`"${r.title}" is now shared across all classes.`);
        render();
      });
    });

    container.querySelectorAll('.btn-dup-rubric').forEach(btn => {
      btn.addEventListener('click', async () => {
        const r = rubrics.find(x => x.id === btn.dataset.id);
        if (!r) return;
        const copy = JSON.parse(JSON.stringify(r));
        copy.id = generateUUID();
        copy.title = `${r.title} (Copy)`;
        copy.created_at = new Date().toISOString();
        copy.updated_at = new Date().toISOString();
        await storage.table('gradebook_rubrics').put(copy);
        toast.success('Rubric duplicated!');
        render();
      });
    });

    container.querySelectorAll('.btn-exp-rubric').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = rubrics.find(x => x.id === btn.dataset.id);
        if (!r) return;
        const blob = new Blob([JSON.stringify({ kennisboost_rubric: true, version: 1, rubric: r }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(r.title || 'rubric').replace(/[^a-z0-9_-]+/gi, '_')}.rubric.json`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 100);
      });
    });

    container.querySelectorAll('.btn-del-rubric').forEach(btn => {
      btn.addEventListener('click', async () => {
        const r = rubrics.find(x => x.id === btn.dataset.id);
        if (!r) return;
        const ok = await ConfirmDialog.show({
          title: 'Delete Rubric?',
          message: `Delete "${r.title}"? Existing graded records keep their saved scores.`,
          confirmText: 'Delete',
          confirmVariant: 'danger'
        });
        if (!ok) return;
        await storage.table('gradebook_rubrics').delete(r.id);
        toast.success('Rubric deleted.');
        render();
      });
    });

    const importInput = container.querySelector('#rubric-import-file');
    container.querySelector('#btn-import-rubric')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const raw = JSON.parse(await file.text());
        const r = raw.rubric || raw;
        if (!r || !Array.isArray(r.criteria) || !Array.isArray(r.tiers)) {
          throw new Error('Invalid rubric JSON format.');
        }
        r.id = generateUUID();
        r.course_id = (scopeFilter !== 'all' && scopeFilter !== 'shared') ? scopeFilter : null;
        r.updated_at = new Date().toISOString();
        await storage.table('gradebook_rubrics').put(r);
        toast.success(`Imported rubric "${r.title || 'Untitled'}"!`);
        render();
      } catch (err) {
        toast.error('Failed to import rubric: ' + err.message);
      }
    });
  };

  await render();
}

export default renderRubricStudio;
