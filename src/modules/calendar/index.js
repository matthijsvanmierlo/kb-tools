import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { setDue } from '../../core/due-dates.js';
import { loadCalendarEvents, generateIcsExport } from './model.js';
import { ClassManager } from '../../components/class-manager.js';
import { RoleMode } from '../../state/role-mode.js';

/**
 * Interactive Calendar Module (KB-CAL-002)
 * Month, Week, Day, and Agenda views with drag/keyboard rescheduling and .ics export.
 */

const esc = (v) => Sanitizer.escapeHTML(v ?? '');
const pad = (n) => String(n).padStart(2, '0');

export function getEventLaunchUrl(ev, isStudent = false) {
  if (!ev) return isStudent ? '#/student' : '#/classes';
  const sourceId = encodeURIComponent(ev.sourceId || ev.id || '');
  if (isStudent) {
    if (ev.kind === 'task') return `#/assignments/work?itemId=${sourceId}`;
    if (ev.kind === 'assignment') return `#/assessments/take?id=${sourceId}`;
    if (ev.kind === 'video') return `#/video/kiosk?id=${sourceId}`;
    if (ev.kind === 'flashcards') return `#/flashcards/study?id=${sourceId}`;
    if (ev.kind === 'timeline') return `#/timeline/view?id=${sourceId}`;
    return ev.courseId ? `#/student/course?id=${encodeURIComponent(ev.courseId)}` : '#/student';
  }
  if (ev.kind === 'task') return `#/assignments/create?id=${sourceId}`;
  if (ev.kind === 'assignment') return `#/assessments/edit?id=${sourceId}`;
  if (ev.kind === 'video') return `#/video/edit?id=${sourceId}`;
  if (ev.kind === 'flashcards') return `#/flashcards/edit?id=${sourceId}`;
  if (ev.kind === 'timeline') return `#/timeline/view?id=${sourceId}`;
  return ev.courseId ? `#/course?id=${encodeURIComponent(ev.courseId)}` : '#/classes';
}

export function getEventActionLabel(ev, isStudent = false) {
  if (!ev) return 'Open';
  if (!isStudent) {
    if (ev.kind === 'task') return 'Edit Assignment';
    if (ev.kind === 'assignment') return 'Edit Assessment';
    const kindName = ev.kind ? (ev.kind.charAt(0).toUpperCase() + ev.kind.slice(1)) : 'Lesson';
    return `Edit ${kindName}`;
  }
  if (ev.kind === 'task') return 'Work on Assignment';
  if (ev.kind === 'assignment') return 'Start Assessment';
  if (ev.kind === 'video') return 'Watch Video Lesson';
  if (ev.kind === 'flashcards') return 'Study Flashcards';
  if (ev.kind === 'timeline') return 'Explore Timeline';
  return 'Open Lesson';
}

export function getEventIcon(kind) {
  if (kind === 'task') return 'journal-text';
  if (kind === 'assignment') return 'file-earmark-check';
  if (kind === 'video') return 'play-circle';
  if (kind === 'flashcards') return 'collection';
  if (kind === 'timeline') return 'clock-history';
  return 'journal-text';
}

export async function renderCalendarView(params, router, container) {
  let activeView = params?.view || 'month'; // 'month', 'week', 'agenda'
  let currentDate = new Date();
  let filterCourseId = params?.courseId || '';

  const render = async () => {
    const isStudent = RoleMode.get() === 'student';
    const [gradebookCourses, studentCourses] = await Promise.all([
      storage.table('gradebook_courses').toArray().catch(() => []),
      storage.table('student_courses').toArray().catch(() => [])
    ]);
    const courseMap = new Map();
    for (const c of [...gradebookCourses, ...studentCourses]) {
      if (c?.id && !courseMap.has(c.id)) {
        courseMap.set(c.id, c);
      }
    }
    const courses = Array.from(courseMap.values());
    const events = await loadCalendarEvents({ courseId: filterCourseId || null });

    const year = currentDate.getFullYear();
    const month = currentDate.getMonth(); // 0-indexed
    const todayStr = new Date().toISOString().slice(0, 10);

    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];

    container.innerHTML = `
      <div class="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
        <!-- Calendar Header Controls -->
        <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-4 rounded-2xl border border-slate-200 shadow-xs">
          <div class="flex items-center gap-3">
            <h1 class="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight" id="cal-heading">
              ${monthNames[month]} ${year}
            </h1>
            <div class="flex items-center gap-1">
              <sl-button size="small" variant="default" id="btn-cal-prev" title="Previous">
                <sl-icon name="chevron-left"></sl-icon>
              </sl-button>
              <sl-button size="small" variant="default" id="btn-cal-today">Today</sl-button>
              <sl-button size="small" variant="default" id="btn-cal-next" title="Next">
                <sl-icon name="chevron-right"></sl-icon>
              </sl-button>
            </div>
          </div>

          <div class="flex items-center gap-2 flex-wrap">
            <!-- Course Filter -->
            <sl-select size="small" id="sel-cal-course" value="${esc(filterCourseId)}" class="w-44">
              <sl-option value="">All Classes</sl-option>
              ${courses.map(c => `<sl-option value="${esc(c.id)}">${esc(c.name)}</sl-option>`).join('')}
            </sl-select>

            <!-- View Switcher -->
            <div class="flex items-center bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-xs">
              <button id="btn-view-month" class="px-3 py-1 rounded-md font-medium transition-all ${activeView === 'month' ? 'bg-white shadow-xs text-slate-900 font-bold' : 'text-slate-500 hover:text-slate-900'}">Month</button>
              <button id="btn-view-week" class="px-3 py-1 rounded-md font-medium transition-all ${activeView === 'week' ? 'bg-white shadow-xs text-slate-900 font-bold' : 'text-slate-500 hover:text-slate-900'}">Week</button>
              <button id="btn-view-agenda" class="px-3 py-1 rounded-md font-medium transition-all ${activeView === 'agenda' ? 'bg-white shadow-xs text-slate-900 font-bold' : 'text-slate-500 hover:text-slate-900'}">Agenda</button>
            </div>

            <!-- Export -->
            <sl-button size="small" variant="default" id="btn-cal-export">
              <sl-icon slot="prefix" name="download"></sl-icon> Export .ics
            </sl-button>
          </div>
        </div>

        <!-- Main View Mount -->
        <div id="cal-view-mount" class="bg-white rounded-2xl border border-slate-200 shadow-xs overflow-hidden">
          <!-- Calendar grid renders here -->
        </div>
      </div>
    `;

    const viewMount = container.querySelector('#cal-view-mount');

    if (activeView === 'month') {
      renderMonthView(viewMount, year, month, events, todayStr, isStudent);
    } else if (activeView === 'week') {
      renderWeekView(viewMount, currentDate, events, todayStr, isStudent);
    } else {
      renderAgendaView(viewMount, events, todayStr, isStudent);
    }

    // Bind Navigation & Controls
    container.querySelector('#btn-cal-prev')?.addEventListener('click', () => {
      if (activeView === 'month') {
        currentDate.setMonth(currentDate.getMonth() - 1);
      } else if (activeView === 'week') {
        currentDate.setDate(currentDate.getDate() - 7);
      }
      render();
    });

    container.querySelector('#btn-cal-next')?.addEventListener('click', () => {
      if (activeView === 'month') {
        currentDate.setMonth(currentDate.getMonth() + 1);
      } else if (activeView === 'week') {
        currentDate.setDate(currentDate.getDate() + 7);
      }
      render();
    });

    container.querySelector('#btn-cal-today')?.addEventListener('click', () => {
      currentDate = new Date();
      render();
    });

    container.querySelector('#btn-view-month')?.addEventListener('click', () => {
      activeView = 'month';
      render();
    });
    container.querySelector('#btn-view-week')?.addEventListener('click', () => {
      activeView = 'week';
      render();
    });
    container.querySelector('#btn-view-agenda')?.addEventListener('click', () => {
      activeView = 'agenda';
      render();
    });

    container.querySelector('#sel-cal-course')?.addEventListener('sl-change', (e) => {
      filterCourseId = e.target.value;
      render();
    });

    container.querySelector('#btn-cal-export')?.addEventListener('click', () => {
      const ics = generateIcsExport(events);
      const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `kennisboost-schedule-${todayStr}.ics`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Calendar exported! Compatible with Google Calendar, Apple Calendar, and Outlook.');
    });
  };

  const renderMonthView = (mount, year, month, events, todayStr, isStudent = false) => {
    const firstDay = new Date(year, month, 1).getDay(); // 0 is Sunday
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();

    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    let html = `
      <div class="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center text-xs font-bold text-slate-500 py-2.5">
        ${dayLabels.map(d => `<div>${d}</div>`).join('')}
      </div>
      <div class="grid grid-cols-7 auto-rows-fr divide-x divide-y divide-slate-100 min-h-[560px]">
    `;

    // Map events by date
    const eventsByDate = new Map();
    for (const ev of events) {
      if (!eventsByDate.has(ev.date)) eventsByDate.set(ev.date, []);
      eventsByDate.get(ev.date).push(ev);
    }

    // Previous month filler days
    for (let i = firstDay - 1; i >= 0; i--) {
      const d = prevMonthDays - i;
      html += `
        <div class="p-2 bg-slate-50/50 text-slate-300 min-h-[100px] text-xs">
          <span>${d}</span>
        </div>
      `;
    }

    // Current month days
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${pad(month + 1)}-${pad(day)}`;
      const isToday = dateStr === todayStr;
      const dayEvents = eventsByDate.get(dateStr) || [];

      html += `
        <div class="p-2 min-h-[100px] transition-colors hover:bg-slate-50/80 group cal-day-cell relative ${isToday ? 'bg-blue-50/30' : ''}" data-date="${dateStr}">
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs font-semibold rounded-full w-6 h-6 flex items-center justify-center ${isToday ? 'bg-primary-600 text-white shadow-xs font-bold' : 'text-slate-700'}">
              ${day}
            </span>
            ${dayEvents.length > 0 ? `<span class="text-[10px] text-slate-400 font-medium">${dayEvents.length}</span>` : ''}
          </div>

          <div class="space-y-1">
            ${dayEvents.slice(0, 3).map(ev => {
              const color = Sanitizer.safeColor(ev.courseColor, '#2563eb');
              return `
                <div class="px-2 py-1 rounded text-[11px] font-medium text-white truncate cursor-pointer shadow-2xs hover:opacity-90 transition-opacity cal-event-chip"
                     style="background-color: ${color};"
                     data-id="${esc(ev.id)}"
                     data-kind="${esc(ev.kind)}"
                     data-source-id="${esc(ev.sourceId)}"
                     title="${esc(ev.title)} (${ev.time || 'All day'})">
                  ${ev.time ? `<span class="opacity-80">${esc(ev.time)}</span> ` : ''}${esc(ev.title)}
                </div>
              `;
            }).join('')}
            ${dayEvents.length > 3 ? `
              <div class="text-[10px] font-semibold text-slate-500 pl-1">+${dayEvents.length - 3} more</div>
            ` : ''}
          </div>
        </div>
      `;
    }

    // Next month filler days to complete grid
    const totalCells = firstDay + daysInMonth;
    const remaining = (7 - (totalCells % 7)) % 7;
    for (let i = 1; i <= remaining; i++) {
      html += `
        <div class="p-2 bg-slate-50/50 text-slate-300 min-h-[100px] text-xs">
          <span>${i}</span>
        </div>
      `;
    }

    html += `</div>`;
    mount.innerHTML = html;

    // Attach Click on Event Chips
    mount.querySelectorAll('.cal-event-chip').forEach(chip => {
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        const evId = chip.dataset.id;
        const ev = events.find(item => item.id === evId);
        if (ev) openEventDetailDialog(ev, () => render());
      });
    });

    // Drag-and-drop or click on day cell (teacher only)
    if (!isStudent) {
      mount.querySelectorAll('.cal-day-cell').forEach(cell => {
        cell.addEventListener('dragover', (e) => e.preventDefault());
        cell.addEventListener('drop', async (e) => {
          e.preventDefault();
          const targetDate = cell.dataset.date;
          const evData = e.dataTransfer.getData('application/json');
          if (evData) {
            try {
              const parsed = JSON.parse(evData);
              await setDue(parsed.kind, parsed.sourceId, { date: targetDate, time: parsed.time });
              toast.success(`Rescheduled to ${targetDate}!`);
              render();
            } catch (err) {
              console.error('Failed to reschedule event:', err);
            }
          }
        });
      });
    }
  };

  const renderWeekView = (mount, date, events, todayStr, isStudent = false) => {
    // Find start of week (Sunday)
    const startOfWeek = new Date(date);
    startOfWeek.setDate(date.getDate() - date.getDay());

    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(startOfWeek);
      d.setDate(startOfWeek.getDate() + i);
      days.push(d.toISOString().slice(0, 10));
    }

    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    mount.innerHTML = `
      <div class="grid grid-cols-7 border-b border-slate-200 bg-slate-50 text-center py-2.5">
        ${days.map((dStr, idx) => {
          const isToday = dStr === todayStr;
          return `
            <div class="${isToday ? 'text-primary-600 font-bold' : 'text-slate-600 font-medium'} text-xs">
              <div>${dayLabels[idx]}</div>
              <div class="text-sm font-bold mt-0.5">${dStr.slice(8)}</div>
            </div>
          `;
        }).join('')}
      </div>
      <div class="grid grid-cols-7 divide-x divide-slate-100 min-h-[500px]">
        ${days.map(dStr => {
          const dayEvents = events.filter(e => e.date === dStr);
          return `
            <div class="p-2 space-y-2">
              ${dayEvents.map(ev => {
                const color = Sanitizer.safeColor(ev.courseColor, '#2563eb');
                return `
                  <div class="p-2 rounded-xl text-white shadow-xs cursor-pointer cal-event-chip"
                       style="background-color: ${color};"
                       data-id="${esc(ev.id)}">
                    <div class="text-xs font-bold leading-tight">${esc(ev.title)}</div>
                    <div class="text-[10px] opacity-90 mt-1">${ev.time || 'All day'} • ${esc(ev.courseName)}</div>
                  </div>
                `;
              }).join('')}
            </div>
          `;
        }).join('')}
      </div>
    `;

    mount.querySelectorAll('.cal-event-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const ev = events.find(item => item.id === chip.dataset.id);
        if (ev) openEventDetailDialog(ev, () => render());
      });
    });
  };

  const renderAgendaView = (mount, events, todayStr, isStudent = false) => {
    if (events.length === 0) {
      mount.innerHTML = `
        <div class="p-12 text-center text-slate-400">
          <sl-icon name="calendar-x" class="text-4xl text-slate-300 mb-2"></sl-icon>
          <p class="text-sm font-medium text-slate-600">No scheduled items found</p>
          <p class="text-xs text-slate-400 mt-1">Assign due dates to assignments, videos, or flashcards to see them here.</p>
        </div>
      `;
      return;
    }

    mount.innerHTML = `
      <div class="divide-y divide-slate-100 p-4">
        ${events.map(ev => {
          const isToday = ev.date === todayStr;
          const isOverdue = ev.date < todayStr;
          const color = Sanitizer.safeColor(ev.courseColor, '#2563eb');

          return `
            <div class="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/80 p-3 rounded-xl transition-colors">
              <div class="flex items-center gap-3.5 min-w-0">
                <div class="w-3 h-10 rounded-full flex-shrink-0" style="background-color: ${color};"></div>
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <h3 class="text-sm font-bold text-slate-900 truncate">${esc(ev.title)}</h3>
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-600">${esc(ev.kind)}</span>
                  </div>
                  <div class="flex items-center gap-2 text-xs text-slate-500 mt-0.5">
                    <span>${esc(ev.courseName)}</span>
                    <span>•</span>
                    <span class="${isOverdue ? 'text-rose-600 font-semibold' : isToday ? 'text-amber-700 font-bold' : 'text-slate-600'}">
                      ${isToday ? 'Today' : ev.date} ${ev.time ? 'at ' + esc(ev.time) : ''}
                    </span>
                    <span>•</span>
                    <span>${ev.points} pts</span>
                  </div>
                </div>
              </div>

              <div class="flex items-center gap-2 self-end sm:self-auto flex-shrink-0">
                <sl-button size="small" variant="default" class="btn-agenda-edit" data-id="${esc(ev.id)}">
                  ${isStudent ? 'Details' : 'Reschedule'}
                </sl-button>
                <sl-button size="small" variant="primary" class="btn-agenda-open" data-id="${esc(ev.id)}">
                  ${isStudent ? getEventActionLabel(ev, true) : 'Open'}
                </sl-button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;

    mount.querySelectorAll('.btn-agenda-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const ev = events.find(item => item.id === btn.dataset.id);
        if (ev) openEventDetailDialog(ev, () => render());
      });
    });

    mount.querySelectorAll('.btn-agenda-open').forEach(btn => {
      btn.addEventListener('click', () => {
        const ev = events.find(item => item.id === btn.dataset.id);
        if (!ev) return;
        window.location.hash = getEventLaunchUrl(ev, isStudent);
      });
    });
  };

  await render();
}

export function openEventDetailDialog(ev, onUpdated) {
  const isStudent = RoleMode.get() === 'student';
  const dialog = document.createElement('sl-dialog');
  dialog.label = ev.title;

  if (isStudent) {
    dialog.innerHTML = `
      <div class="space-y-4 py-1 text-sm">
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1">
          <div>Class: <strong>${esc(ev.courseName)}</strong></div>
          <div>Type: <span class="capitalize">${esc(ev.kind)}</span></div>
          <div>Points: ${ev.points}</div>
        </div>

        <div class="p-3 rounded-xl bg-blue-50/60 border border-blue-100 text-xs text-blue-900 space-y-1">
          <div class="font-semibold text-blue-950 flex items-center gap-1.5">
            <sl-icon name="calendar-event"></sl-icon> Due Information
          </div>
          <div>Date: <strong>${ev.date ? esc(ev.date) : 'No due date'}</strong></div>
          ${ev.time ? `<div>Time: <strong>${esc(ev.time)}</strong></div>` : ''}
        </div>
      </div>
      <div slot="footer" class="flex justify-between items-center gap-2">
        <sl-button variant="default" id="btn-cancel-ev">Close</sl-button>
        <sl-button variant="primary" id="btn-open-lesson">
          <sl-icon slot="prefix" name="${getEventIcon(ev.kind)}"></sl-icon>
          ${getEventActionLabel(ev, true)}
        </sl-button>
      </div>
    `;
  } else {
    dialog.innerHTML = `
      <div class="space-y-4 py-1 text-sm">
        <div class="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1">
          <div>Class: <strong>${esc(ev.courseName)}</strong></div>
          <div>Type: <span class="capitalize">${esc(ev.kind)}</span></div>
          <div>Points: ${ev.points}</div>
        </div>

        <div class="space-y-3">
          <sl-input type="date" id="input-ev-date" label="Due Date" value="${esc(ev.date || '')}"></sl-input>
          <sl-input type="time" id="input-ev-time" label="Due Time" value="${esc(ev.time || '')}"></sl-input>
        </div>
      </div>
      <div slot="footer" class="flex justify-between gap-2">
        <sl-button variant="default" id="btn-open-lesson">${getEventActionLabel(ev, false)}</sl-button>
        <div class="flex gap-2">
          <sl-button variant="default" id="btn-cancel-ev">Cancel</sl-button>
          <sl-button variant="primary" id="btn-save-ev">Save Date</sl-button>
        </div>
      </div>
    `;
  }

  document.body.appendChild(dialog);
  dialog.show?.();

  dialog.querySelector('#btn-cancel-ev')?.addEventListener('click', () => dialog.hide?.());
  dialog.querySelector('#btn-open-lesson')?.addEventListener('click', () => {
    dialog.hide?.();
    window.location.hash = getEventLaunchUrl(ev, isStudent);
  });

  dialog.querySelector('#btn-save-ev')?.addEventListener('click', async () => {
    const newDate = dialog.querySelector('#input-ev-date')?.value || null;
    const newTime = dialog.querySelector('#input-ev-time')?.value || null;

    await setDue(ev.kind, ev.sourceId, { date: newDate, time: newTime });
    toast.success('Due date updated!');
    dialog.hide?.();
    if (onUpdated) onUpdated();
  });

  dialog.addEventListener('sl-after-hide', () => dialog.remove());
  return dialog;
}
