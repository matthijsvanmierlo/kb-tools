/**
 * Study planner (KB-CARD-PLAN): FSRS target-retention control + 7-day review forecast.
 *
 * Moving the slider previews the forecast live; releasing it saves the target and reschedules
 * every review card so due dates match the new retention.
 */
import { storage } from '../../core/storage.js';
import { Sanitizer } from '../../core/sanitizer.js';
import { toast } from '../../utils/toast.js';
import { fsrs, DEFAULT_RETENTION, MIN_RETENTION, MAX_RETENTION, RETENTION_METADATA_KEY } from './fsrs.js';

const esc = (v) => Sanitizer.escapeHTML(v);

/** Load the saved retention target into the shared scheduler */
export async function applySavedRetention() {
  const saved = await storage.getMetadata(RETENTION_METADATA_KEY);
  return fsrs.setRequestRetention(saved ?? DEFAULT_RETENTION);
}

function dayLabel(date, i) {
  if (i === 0) return 'Today';
  if (i === 1) return 'Tmrw';
  return date.toLocaleDateString(undefined, { weekday: 'short' });
}

function renderForecast(el, forecast) {
  if (forecast.days.every(d => d.count === 0)) {
    el.innerHTML = `<p class="text-sm text-slate-500 py-6">No reviews scheduled this week${forecast.newCards ? ` · ${esc(forecast.newCards)} new card${forecast.newCards === 1 ? '' : 's'} waiting to be studied` : ''}. Study a deck and your review schedule appears here.</p>`;
    return;
  }
  const max = Math.max(1, ...forecast.days.map(d => d.count));
  const peak = forecast.days.reduce((best, d, i) => (d.count > forecast.days[best].count ? i : best), 0);
  const total = forecast.days.reduce((s, d) => s + d.count, 0);
  const summary = forecast.days.map((d, i) => `${dayLabel(d.date, i)} ${d.count}`).join(', ');

  el.innerHTML = `
    <div class="kb-forecast" role="img" aria-label="Reviews due over the next 7 days: ${esc(summary)}">
      ${forecast.days.map((d, i) => {
        const full = d.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
        const tip = `${full}: ${d.count} review${d.count === 1 ? '' : 's'}${i === 0 && forecast.overdue ? ` (${forecast.overdue} overdue)` : ''}`;
        return `
          <div class="kb-forecast-col" title="${esc(tip)}">
            <span class="kb-forecast-value">${i === peak && d.count > 0 ? esc(d.count) : ''}</span>
            <span class="kb-forecast-bar" style="height:${d.count ? Math.max(4, Math.round((d.count / max) * 100)) : 0}%"></span>
            <span class="kb-forecast-day">${esc(dayLabel(d.date, i))}</span>
          </div>`;
      }).join('')}
    </div>
    <table class="sr-only">
      <caption>Reviews due per day</caption>
      <tr><th scope="col">Day</th><th scope="col">Reviews</th></tr>
      ${forecast.days.map((d, i) => `<tr><td>${esc(dayLabel(d.date, i))}</td><td>${esc(d.count)}</td></tr>`).join('')}
    </table>
    <p class="text-xs text-slate-500 mt-2">
      ${esc(total)} review${total === 1 ? '' : 's'} this week${forecast.overdue ? ` · ${esc(forecast.overdue)} overdue now` : ''}${forecast.newCards ? ` · ${esc(forecast.newCards)} new card${forecast.newCards === 1 ? '' : 's'} not started yet` : ''}
    </p>`;
}

/**
 * @param {HTMLElement} el
 */
export async function renderStudyPlanner(el) {
  await applySavedRetention();
  const decks = await storage.table('flashcards').toArray();
  const cards = decks.flatMap(d => d.cards || []);
  if (!cards.length) {
    el.innerHTML = '';
    return;
  }

  const pct = Math.round(fsrs.requestRetention * 100);
  el.innerHTML = `
    <section class="kb-study-planner bg-white rounded-2xl border border-slate-200 shadow-xs p-5 grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]" aria-labelledby="planner-title">
      <div class="space-y-3">
        <h2 id="planner-title" class="font-semibold text-slate-900 flex items-center gap-2"><sl-icon name="calendar-week" aria-hidden="true"></sl-icon> Study planner</h2>
        <sl-range id="planner-retention" label="Target retention" min="${MIN_RETENTION * 100}" max="${MAX_RETENTION * 100}" step="1" value="${pct}"
          help-text="How likely you want to be to remember a card when it comes up. Higher means remembering more, but reviewing more often."></sl-range>
        <p class="text-sm text-slate-700"><strong data-retention-value>${pct}%</strong> <span class="text-slate-500" data-retention-hint></span></p>
      </div>
      <div>
        <h3 class="text-sm font-medium text-slate-700 mb-2">Reviews due, next 7 days</h3>
        <div data-forecast></div>
      </div>
    </section>`;

  const slider = el.querySelector('#planner-retention');
  const valueEl = el.querySelector('[data-retention-value]');
  const hintEl = el.querySelector('[data-retention-hint]');
  const forecastEl = el.querySelector('[data-forecast]');
  slider.tooltipFormatter = (v) => `${v}%`;

  const preview = (value) => {
    const r = value / 100;
    valueEl.textContent = `${value}%`;
    hintEl.textContent = r >= 0.93 ? '— maximum recall, heaviest workload' : r <= 0.84 ? '— lightest workload, more forgetting' : r === DEFAULT_RETENTION ? '— recommended balance' : '';
    renderForecast(forecastEl, fsrs.forecastWorkload(cards, { retention: r }));
  };
  preview(pct);

  slider.addEventListener('sl-input', () => preview(Number(slider.value)));
  slider.addEventListener('sl-change', async () => {
    const r = fsrs.setRequestRetention(Number(slider.value) / 100);
    await storage.setMetadata(RETENTION_METADATA_KEY, r);
    const changedDecks = [];
    for (const deck of decks) {
      if (fsrs.rescheduleCards(deck.cards || []).length) changedDecks.push(deck);
    }
    if (changedDecks.length) await storage.table('flashcards').bulkPut(changedDecks);
    toast.success(`Target retention set to ${Math.round(r * 100)}%.`);
  });
}
