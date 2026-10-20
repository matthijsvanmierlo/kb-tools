import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { ConfirmDialog, PromptDialog } from '../../utils/dialogs.js';
import { generateUUID } from '../../utils/uuid.js';
import { setDue, getDue } from '../../core/due-dates.js';
import { buildCourseFeed } from '../../core/course-feed.js';
import { getTransport, PublicFeedTransport } from '../../core/transport.js';
import { isFeedDirty, markFeedPublished } from '../../core/course-revision.js';
import { QRCode } from '../../core/qrcode.js';

const esc = (v) => Sanitizer.escapeHTML(v ?? '');

export async function renderCoursePage(courseId, container) {
  if (!courseId) {
    container.innerHTML = `
      <div class="p-8 text-center text-slate-500">
        <p>No course ID provided.</p>
        <sl-button size="small" class="mt-4" href="#/classes">Go to Classes</sl-button>
      </div>
    `;
    return;
  }

  const course = await storage.table('gradebook_courses').get(courseId);
  if (!course) {
    container.innerHTML = `
      <div class="p-8 text-center text-slate-500">
        <p>Course not found.</p>
        <sl-button size="small" class="mt-4" href="#/classes">Go to Classes</sl-button>
      </div>
    `;
    return;
  }

  const render = async () => {
    const [units, items] = await Promise.all([
      storage.table('course_units').where('course_id').equals(courseId).toArray().catch(() => []),
      storage.table('course_items').where('course_id').equals(courseId).toArray().catch(() => [])
    ]);

    units.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    items.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const dirty = await isFeedDirty(courseId).catch(() => false);
    const color = Sanitizer.safeColor(course.color, '#2563eb');

    container.innerHTML = `
      <div class="min-h-[calc(100vh-4rem)] bg-slate-50 pb-16">
        <!-- Course Header Banner -->
        <header class="bg-white border-b border-slate-200">
          <div class="max-w-6xl mx-auto px-4 sm:px-6 py-6">
            <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div class="flex items-center gap-3.5 min-w-0">
                <div class="w-4 h-14 rounded-lg flex-shrink-0 shadow-xs" style="background-color: ${color};"></div>
                <div class="min-w-0">
                  <div class="flex items-center gap-2 flex-wrap">
                    <h1 class="text-2xl font-bold text-slate-900 tracking-tight truncate">${esc(course.name)}</h1>
                    ${course.section ? `<span class="px-2.5 py-0.5 rounded-md text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">${esc(course.section)}</span>` : ''}
                    ${course.academic_year ? `<span class="text-xs text-slate-500 font-medium">(${esc(course.academic_year)})</span>` : ''}
                  </div>
                  <div class="flex items-center gap-3 text-xs text-slate-500 mt-1 flex-wrap">
                    <span>Access Code: <strong class="font-mono text-primary-700 bg-primary-50 px-1.5 py-0.5 rounded border border-primary-200">${esc(course.access_code || '------')}</strong></span>
                    <span>•</span>
                    <span>${units.length} Unit${units.length === 1 ? '' : 's'}</span>
                    <span>•</span>
                    <span>${items.length} Item${items.length === 1 ? '' : 's'}</span>
                    ${dirty ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800">Unpublished Changes</span>' : '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800">Feed In Sync</span>'}
                  </div>
                </div>
              </div>

              <!-- Action Buttons -->
              <div class="flex items-center gap-2 flex-wrap">
                <sl-button size="small" variant="default" id="btn-course-share-card">
                  <sl-icon slot="prefix" name="qr-code"></sl-icon> Student Card
                </sl-button>
                <sl-button size="small" variant="default" href="#/classes?courseId=${esc(course.id)}&tab=roster">
                  <sl-icon slot="prefix" name="people"></sl-icon> Roster
                </sl-button>
                <sl-button size="small" variant="default" href="#/gradebook?courseId=${esc(course.id)}">
                  <sl-icon slot="prefix" name="journal-bookmark"></sl-icon> Gradebook
                </sl-button>
                <sl-button size="small" variant="${dirty ? 'primary' : 'default'}" id="btn-publish-feed">
                  <sl-icon slot="prefix" name="cloud-upload"></sl-icon> Publish Feed
                </sl-button>
              </div>
            </div>
          </div>
        </header>

        <!-- Main Units Container -->
        <main class="max-w-6xl mx-auto px-4 sm:px-6 pt-6">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-base font-bold text-slate-800">Course Outline &amp; Syllabus</h2>
            <sl-button size="small" variant="primary" id="btn-add-unit">
              <sl-icon slot="prefix" name="plus-lg"></sl-icon> Add Unit
            </sl-button>
          </div>

          <!-- Unit List -->
          <div class="space-y-6" id="units-mount">
            ${units.length === 0 ? `
              <div class="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center text-slate-400">
                <sl-icon name="folder2-open" class="text-5xl text-slate-300 mb-3"></sl-icon>
                <h3 class="text-base font-semibold text-slate-700">No units yet</h3>
                <p class="text-xs text-slate-500 max-w-sm mx-auto mt-1">Organize your course into chronological units, modules, or thematic chapters. Click "Add Unit" to get started.</p>
                <sl-button size="small" variant="primary" class="mt-4" id="btn-add-unit-empty">
                  <sl-icon slot="prefix" name="plus-lg"></sl-icon> Add First Unit
                </sl-button>
              </div>
            ` : units.map((u, uIdx) => {
              const unitItems = items.filter(it => it.unit_id === u.id);
              return `
                <section class="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden transition-all" data-unit-id="${esc(u.id)}">
                  <!-- Unit Header -->
                  <div class="bg-slate-50/80 border-b border-slate-200 px-5 py-3.5 flex items-center justify-between gap-3">
                    <div class="flex items-center gap-2.5 min-w-0">
                      <span class="w-6 h-6 rounded-full bg-slate-200 text-slate-700 font-semibold text-xs flex items-center justify-center flex-shrink-0">
                        ${uIdx + 1}
                      </span>
                      <div class="min-w-0">
                        <h3 class="text-sm font-bold text-slate-900 truncate">${esc(u.title || 'Untitled Unit')}</h3>
                        ${u.description ? `<p class="text-xs text-slate-500 truncate">${esc(u.description)}</p>` : ''}
                      </div>
                    </div>
                    <div class="flex items-center gap-1">
                      <sl-button size="small" variant="default" class="btn-add-item-to-unit" data-unit-id="${esc(u.id)}">
                        <sl-icon slot="prefix" name="plus-lg"></sl-icon> Add Item
                      </sl-button>
                      <sl-dropdown placement="bottom-end">
                        <button slot="trigger" class="p-1.5 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 cursor-pointer" aria-label="Unit options">
                          <sl-icon name="three-dots-vertical"></sl-icon>
                        </button>
                        <sl-menu>
                          <sl-menu-item class="menu-rename-unit" data-unit-id="${esc(u.id)}" data-title="${esc(u.title)}">
                            <sl-icon slot="prefix" name="pencil"></sl-icon> Rename Unit...
                          </sl-menu-item>
                          <sl-menu-item class="menu-delete-unit text-rose-600" data-unit-id="${esc(u.id)}">
                            <sl-icon slot="prefix" name="trash"></sl-icon> Delete Unit
                          </sl-menu-item>
                        </sl-menu>
                      </sl-dropdown>
                    </div>
                  </div>

                  <!-- Unit Items List -->
                  <div class="divide-y divide-slate-100 p-2">
                    ${unitItems.length === 0 ? `
                      <div class="py-6 text-center text-xs text-slate-400">
                        No items in this unit yet. Click "+ Add Item" to attach assignments, decks, videos, or timelines.
                      </div>
                    ` : unitItems.map(it => {
                      const kind = it.kind || it.type || 'assignment';
                      const icons = {
                        assignment: 'file-earmark-check text-blue-600',
                        flashcards: 'collection text-purple-600',
                        timeline: 'clock-history text-emerald-600',
                        video: 'play-circle text-rose-600',
                        link: 'link-45deg text-amber-600'
                      };
                      const iconClass = icons[kind] || 'file-earmark text-slate-500';

                      return `
                        <div class="flex items-center justify-between p-3 rounded-xl hover:bg-slate-50/80 transition-colors gap-3 item-row" data-item-id="${esc(it.id)}">
                          <div class="flex items-center gap-3 min-w-0 flex-1">
                            <sl-icon name="${iconClass.split(' ')[0]}" class="text-lg flex-shrink-0 ${iconClass.split(' ')[1] || ''}"></sl-icon>
                            <div class="min-w-0 flex-1">
                              <div class="flex items-center gap-2">
                                <span class="text-sm font-semibold text-slate-900 truncate">${esc(it.title)}</span>
                                <span class="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">${esc(kind)}</span>
                              </div>
                              <div class="flex items-center gap-2 text-xs text-slate-500 mt-0.5">
                                ${it.due_date ? `
                                  <span class="text-amber-700 font-medium flex items-center gap-1">
                                    <sl-icon name="calendar-event"></sl-icon> Due: ${esc(it.due_date)}${it.due_time ? ' ' + esc(it.due_time) : ''}
                                  </span>
                                ` : '<span class="text-slate-400">No due date</span>'}
                                <span>•</span>
                                <span>${it.points ?? 100} pts</span>
                              </div>
                            </div>
                          </div>

                          <div class="flex items-center gap-1 flex-shrink-0">
                            <sl-tooltip content="Change Due Date">
                              <sl-button size="small" variant="text" class="btn-change-item-due" data-id="${esc(it.id)}" data-kind="${esc(kind)}" data-source-id="${esc(it.source_id || it.id)}">
                                <sl-icon name="calendar-date"></sl-icon>
                              </sl-button>
                            </sl-tooltip>
                            <sl-tooltip content="Remove from Unit">
                              <sl-button size="small" variant="text" class="btn-remove-item text-rose-500" data-id="${esc(it.id)}">
                                <sl-icon name="trash"></sl-icon>
                              </sl-button>
                            </sl-tooltip>
                          </div>
                        </div>
                      `;
                    }).join('')}
                  </div>
                </section>
              `;
            }).join('')}
          </div>
        </main>
      </div>
    `;

    // Bind Event Listeners
    container.querySelector('#btn-add-unit')?.addEventListener('click', async () => {
      const title = await PromptDialog.show({
        title: 'New Course Unit',
        message: 'Enter the title for this unit (e.g. "Unit 1: The Solar System")',
        placeholder: 'Unit title'
      });
      if (!title) return;

      const newUnit = {
        id: generateUUID(),
        course_id: courseId,
        title: title.trim(),
        order: units.length,
        created_at: new Date().toISOString()
      };
      await storage.table('course_units').put(newUnit);
      toast.success('Unit created!');
      render();
    });

    container.querySelector('#btn-add-unit-empty')?.addEventListener('click', () => {
      container.querySelector('#btn-add-unit')?.click();
    });

    container.querySelectorAll('.menu-rename-unit').forEach(el => {
      el.addEventListener('click', async () => {
        const uId = el.dataset.unitId;
        const currentTitle = el.dataset.title;
        const nextTitle = await PromptDialog.show({
          title: 'Rename Unit',
          message: 'Enter a new title for this unit',
          defaultValue: currentTitle
        });
        if (!nextTitle || nextTitle === currentTitle) return;

        const unit = await storage.table('course_units').get(uId);
        if (unit) {
          unit.title = nextTitle.trim();
          unit.updated_at = new Date().toISOString();
          await storage.table('course_units').put(unit);
          toast.success('Unit renamed!');
          render();
        }
      });
    });

    container.querySelectorAll('.menu-delete-unit').forEach(el => {
      el.addEventListener('click', async () => {
        const uId = el.dataset.unitId;
        const confirmed = await ConfirmDialog.show({
          title: 'Delete Unit',
          message: 'Are you sure you want to delete this unit? Items in this unit will be unlinked but will remain in your library.',
          confirmText: 'Delete Unit',
          confirmVariant: 'danger'
        });
        if (!confirmed) return;

        await storage.table('course_units').delete(uId);
        // Also remove or unlink items
        const unitItems = await storage.table('course_items').where('unit_id').equals(uId).toArray();
        for (const it of unitItems) {
          await storage.table('course_items').delete(it.id);
        }
        toast.info('Unit deleted.');
        render();
      });
    });

    // Add Item Dialog
    container.querySelectorAll('.btn-add-item-to-unit').forEach(btn => {
      btn.addEventListener('click', async () => {
        const uId = btn.dataset.unitId;
        await openAddItemDialog(courseId, uId, () => render());
      });
    });

    // Change Due Date
    container.querySelectorAll('.btn-change-item-due').forEach(btn => {
      btn.addEventListener('click', async () => {
        const itemId = btn.dataset.id;
        const kind = btn.dataset.kind;
        const sourceId = btn.dataset.sourceId;
        await openChangeDueDialog(kind, sourceId, itemId, () => render());
      });
    });

    // Remove Item
    container.querySelectorAll('.btn-remove-item').forEach(btn => {
      btn.addEventListener('click', async () => {
        const itemId = btn.dataset.id;
        await storage.table('course_items').delete(itemId);
        toast.info('Item removed from course.');
        render();
      });
    });

    // Publish Feed
    container.querySelector('#btn-publish-feed')?.addEventListener('click', async () => {
      const btn = container.querySelector('#btn-publish-feed');
      btn.loading = true;
      try {
        const feed = await buildCourseFeed(courseId);
        const transport = await getTransport();
        const config = await storage.getMetadata('sync_config');

        if (config?.baseUrl && config?.token) {
          const feedTransport = new PublicFeedTransport(config);
          await feedTransport.publishCourseFeed(courseId, feed.ciphertext, feed.etag);
          await markFeedPublished(courseId, feed.etag);
          toast.success('Course feed published to server!');
        } else {
          await markFeedPublished(courseId, feed.etag);
          toast.success('Course feed packaged!');
        }
        await openShareCoursePackageDialog(course);
        render();
      } catch (err) {
        console.error('Failed to publish course feed:', err);
        toast.danger('Could not publish course feed: ' + err.message);
      } finally {
        btn.loading = false;
      }
    });

    // Student Card / QR
    container.querySelector('#btn-course-share-card')?.addEventListener('click', () => {
      openShareCoursePackageDialog(course);
    });
  };

  await render();
}

async function openAddItemDialog(courseId, unitId, onAdded) {
  const [assignments, decks, timelines, videos] = await Promise.all([
    storage.table('assignments').toArray().catch(() => []),
    storage.table('flashcards').toArray().catch(() => []),
    storage.table('timelines').toArray().catch(() => []),
    storage.table('video_assessments').toArray().catch(() => [])
  ]);

  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Add Item to Unit';
  dialog.style.setProperty('--width', '600px');
  dialog.innerHTML = `
    <div class="space-y-4 py-1 text-sm">
      <sl-select label="Select Content Source" id="sel-item-source" value="assignment">
        <sl-option value="assignment">Assignment (${assignments.length} available)</sl-option>
        <sl-option value="flashcards">Flashcard Deck (${decks.length} available)</sl-option>
        <sl-option value="timeline">Timeline (${timelines.length} available)</sl-option>
        <sl-option value="video">Video Assessment (${videos.length} available)</sl-option>
      </sl-select>

      <div id="content-selector-mount">
        <!-- Select box mounts here -->
      </div>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="default" id="btn-cancel-add-item">Cancel</sl-button>
      <sl-button variant="primary" id="btn-confirm-add-item">Add to Unit</sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  const sourceSelect = dialog.querySelector('#sel-item-source');
  const mount = dialog.querySelector('#content-selector-mount');

  const updateSelect = () => {
    const val = sourceSelect.value;
    let items = [];
    if (val === 'assignment') items = assignments;
    else if (val === 'flashcards') items = decks;
    else if (val === 'timeline') items = timelines;
    else if (val === 'video') items = videos;

    if (items.length === 0) {
      mount.innerHTML = `<p class="text-xs text-slate-400 py-2">No items found in your library for this category.</p>`;
      return;
    }

    mount.innerHTML = `
      <sl-select label="Choose Item" id="sel-target-item" value="${esc(items[0]?.id)}">
        ${items.map(it => `<sl-option value="${esc(it.id)}">${esc(it.title || it.name || 'Untitled')}</sl-option>`).join('')}
      </sl-select>
    `;
  };

  updateSelect();
  sourceSelect.addEventListener('sl-change', updateSelect);

  dialog.querySelector('#btn-cancel-add-item')?.addEventListener('click', () => dialog.hide());
  dialog.querySelector('#btn-confirm-add-item')?.addEventListener('click', async () => {
    const targetSelect = dialog.querySelector('#sel-target-item');
    const selectedId = targetSelect?.value;
    const kind = sourceSelect.value;

    if (!selectedId) {
      toast.warning('Please select an item.');
      return;
    }

    let sourceItem = null;
    if (kind === 'assignment') sourceItem = assignments.find(a => a.id === selectedId);
    else if (kind === 'flashcards') sourceItem = decks.find(d => d.id === selectedId);
    else if (kind === 'timeline') sourceItem = timelines.find(t => t.id === selectedId);
    else if (kind === 'video') sourceItem = videos.find(v => v.id === selectedId);

    const title = sourceItem?.title || sourceItem?.name || 'Untitled Item';
    const newItem = {
      id: generateUUID(),
      course_id: courseId,
      unit_id: unitId,
      title,
      kind,
      source_id: selectedId,
      order: 100,
      points: sourceItem?.total_points || 100,
      due_date: sourceItem?.due_date || null,
      due_time: sourceItem?.due_time || null,
      created_at: new Date().toISOString()
    };

    await storage.table('course_items').put(newItem);
    dialog.hide();
    toast.success(`Added "${title}" to unit!`);
    if (onAdded) onAdded();
  });

  dialog.addEventListener('sl-after-hide', () => dialog.remove());
}

async function openChangeDueDialog(kind, sourceId, itemId, onSaved) {
  const due = await getDue(kind, sourceId).catch(() => ({ date: null, time: null }));

  const dialog = document.createElement('sl-dialog');
  dialog.label = 'Update Due Date';
  dialog.innerHTML = `
    <div class="space-y-3 py-1 text-sm">
      <sl-input type="date" id="input-due-date" label="Due Date" value="${esc(due?.date || '')}"></sl-input>
      <sl-input type="time" id="input-due-time" label="Due Time" value="${esc(due?.time || '')}"></sl-input>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="default" id="btn-cancel-due">Cancel</sl-button>
      <sl-button variant="primary" id="btn-save-due">Save Due Date</sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-cancel-due')?.addEventListener('click', () => dialog.hide());
  dialog.querySelector('#btn-save-due')?.addEventListener('click', async () => {
    const date = dialog.querySelector('#input-due-date')?.value || null;
    const time = dialog.querySelector('#input-due-time')?.value || null;

    await setDue(kind, sourceId, { date, time });

    // Also update course_item record directly
    if (itemId) {
      const it = await storage.table('course_items').get(itemId);
      if (it) {
        it.due_date = date;
        it.due_time = time;
        it.updated_at = new Date().toISOString();
        await storage.table('course_items').put(it);
      }
    }

    dialog.hide();
    toast.success('Due date updated across all course views!');
    if (onSaved) onSaved();
  });

  dialog.addEventListener('sl-after-hide', () => dialog.remove());
}

function openStudentCardDialog(course) {
  openShareCoursePackageDialog(course);
}

async function openShareCoursePackageDialog(course) {
  const { CryptoShareEngine } = await import('../../core/crypto-share.js');
  const { downloadClickableHtmlFile } = await import('../../core/html-launcher.js');
  const { showQrSequence } = await import('../../components/qr-handoff.js');
  const { buildCourseFeed } = await import('../../core/course-feed.js');

  toast.info('Preparing course package...', 1500);
  let sharePayload = null;
  try {
    const feed = await buildCourseFeed(course.id);
    sharePayload = await CryptoShareEngine.createSharePayload('course_feed', feed.raw_payload, course.access_code);
  } catch (err) {
    console.error('Failed to create course package:', err);
    toast.danger('Could not build course package: ' + err.message);
    return;
  }

  const base = window.location.origin + window.location.pathname;
  const joinUrl = `${base}#/student?code=${encodeURIComponent(course.access_code || '')}`;
  const shareUrl = sharePayload.url;

  let qrSvg = '';
  try {
    qrSvg = QRCode.generateSVG(joinUrl, { size: 160, margin: 1 });
  } catch {
    qrSvg = '<span>QR Code</span>';
  }

  const dialog = document.createElement('sl-dialog');
  dialog.label = `Share Course · ${course.name}`;
  dialog.style.setProperty('--width', 'min(580px, 96vw)');
  dialog.innerHTML = `
    <div class="space-y-4">
      <div class="rounded-xl border border-primary-200 bg-primary-50/60 p-4 flex items-center justify-between gap-4">
        <div>
          <h3 class="font-bold text-slate-900">${esc(course.name)}</h3>
          <p class="text-xs text-slate-600 mt-0.5">${esc(course.section || '')} ${course.academic_year ? '• ' + esc(course.academic_year) : ''}</p>
        </div>
        <div class="text-right">
          <span class="text-[10px] uppercase font-bold text-slate-500 block">Access Code</span>
          <span class="font-mono font-bold text-primary-700 text-lg">${esc(course.access_code || '------')}</span>
        </div>
      </div>

      <div class="flex justify-center p-2 bg-slate-50 rounded-xl border border-slate-100">
        ${qrSvg}
      </div>

      <div class="space-y-3">
        <div>
          <label class="text-xs font-semibold text-slate-700 block mb-1">Student Join Link (Instant Enrollment)</label>
          <div class="flex gap-2">
            <sl-input id="input-join-url" value="${esc(joinUrl)}" readonly size="small" class="flex-1 font-mono text-xs"></sl-input>
            <sl-button size="small" variant="default" id="btn-copy-join">
              <sl-icon slot="prefix" name="clipboard"></sl-icon> Copy
            </sl-button>
          </div>
        </div>

        <div>
          <label class="text-xs font-semibold text-slate-700 block mb-1">Encrypted Offline Course Package Link</label>
          <div class="flex gap-2">
            <sl-input id="input-feed-url" value="${esc(shareUrl)}" readonly size="small" class="flex-1 font-mono text-xs"></sl-input>
            <sl-button size="small" variant="default" id="btn-copy-feed">
              <sl-icon slot="prefix" name="clipboard"></sl-icon> Copy
            </sl-button>
          </div>
        </div>
      </div>

      <div class="pt-2 border-t border-slate-100 flex flex-wrap gap-2">
        <sl-button size="small" variant="primary" id="btn-show-course-qr">
          <sl-icon slot="prefix" name="qr-code-scan"></sl-icon> Project Join QR
        </sl-button>
        <sl-button size="small" variant="default" id="btn-download-course-html">
          <sl-icon slot="prefix" name="file-earmark-code"></sl-icon> Clickable Course (.html)
        </sl-button>
        <sl-button size="small" variant="default" id="btn-download-course-file">
          <sl-icon slot="prefix" name="file-earmark-arrow-down"></sl-icon> Download .kbshare
        </sl-button>
      </div>
    </div>
    <div slot="footer" class="flex justify-end gap-2">
      <sl-button variant="primary" id="btn-close-share">Done</sl-button>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.show();

  dialog.querySelector('#btn-close-share')?.addEventListener('click', () => dialog.hide());
  dialog.querySelector('#btn-copy-join')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      toast.success('Join link copied!');
    } catch (_) {
      toast.warning('Copy failed.');
    }
  });

  dialog.querySelector('#btn-copy-feed')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success('Course package link copied!');
    } catch (_) {
      toast.warning('Copy failed.');
    }
  });

  dialog.querySelector('#btn-show-course-qr')?.addEventListener('click', () => {
    showQrSequence(joinUrl, {
      title: `Enroll in ${course.name}`,
      intro: `Scan with camera to enroll in ${course.name} (Code: ${course.access_code}).`,
      preferDirectUrl: true
    });
  });

  dialog.querySelector('#btn-download-course-html')?.addEventListener('click', () => {
    const cleanName = (course.name || 'course').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    downloadClickableHtmlFile({
      title: `${course.name} · Course Package`,
      payloadType: 'course_feed',
      payload: sharePayload.rawFileContent,
      shareUrl
    }, `${cleanName}_course.kbshare.html`);
    toast.success('Downloaded clickable course package (.kbshare.html)!');
  });

  dialog.querySelector('#btn-download-course-file')?.addEventListener('click', () => {
    const cleanName = (course.name || 'course').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    CryptoShareEngine.downloadKbShareFile(
      sharePayload.rawFileContent,
      `${cleanName}_course.kbshare`
    );
    toast.success('Downloaded course package (.kbshare)!');
  });

  dialog.addEventListener('sl-after-hide', () => dialog.remove());
}
