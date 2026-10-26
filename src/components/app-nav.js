import { RoleMode } from '../state/role-mode.js';
import { Sanitizer } from '../core/sanitizer.js';

/**
 * Data-Driven Application Navigation (KB-NAV-001)
 * Dynamic role-based navigation bar for desktop and mobile bottom tab bar with More drawer.
 */

const esc = (s) => Sanitizer.escapeHTML(String(s ?? ''));

export const NAV_CONFIG = {
  teacher: {
    primary: [
      { id: 'nav-home', route: '#/', label: 'Home', icon: 'house-door' },
      { id: 'nav-courses', route: '#/course', label: 'Courses', icon: 'journal-bookmark' },
      { id: 'nav-calendar', route: '#/calendar', label: 'Calendar', icon: 'calendar3' },
      { id: 'nav-gradebook', route: '#/gradebook', label: 'Gradebook', icon: 'journal-check' }
    ],
    secondary: [
      { id: 'nav-classes', route: '#/classes', label: 'Classes & Rosters', shortLabel: 'Classes', icon: 'people' },
      { id: 'nav-inbox', route: '#/inbox', label: 'Inbox', icon: 'inbox' }
    ],
    dropdown: {
      label: 'Create',
      icon: 'plus-circle',
      items: [
        { id: 'nav-asg', route: '#/assessments', label: 'Assessments', icon: 'ui-checks' },
        { id: 'nav-tasks', route: '#/assignments', label: 'Assignments', icon: 'journal-text' },
        { id: 'nav-fc', route: '#/flashcards', label: 'Flashcards', icon: 'stack' },
        { id: 'nav-tl', route: '#/timeline', label: 'Timeline', icon: 'bar-chart-steps' },
        { id: 'nav-vid', route: '#/video', label: 'Video', icon: 'play-circle' }
      ]
    }
  },
  student: {
    primary: [
      { id: 'nav-student-hub', route: '#/student', label: 'Student Hub', icon: 'house-door' },
      { id: 'nav-student-courses', route: '#/student/courses', label: 'My Courses', icon: 'journal-bookmark' },
      { id: 'nav-student-calendar', route: '#/calendar', label: 'Calendar', icon: 'calendar3' },
      { id: 'nav-student-grades', route: '#/student/gradebook', label: 'My Grades', icon: 'journal-check' }
    ],
    secondary: [],
    dropdown: {
      label: 'Study',
      icon: 'book',
      items: [
        { id: 'nav-study-fc', route: '#/flashcards', label: 'Flashcards', icon: 'stack' },
        { id: 'nav-study-tl', route: '#/timeline', label: 'Timeline', icon: 'bar-chart-steps' },
        { id: 'nav-study-vid', route: '#/video', label: 'Video', icon: 'play-circle' }
      ]
    }
  }
};

let currentActiveRoute = '';

export function renderAppNav(container, role = RoleMode.get()) {
  if (!container) return;
  const config = NAV_CONFIG[role] || NAV_CONFIG.teacher;

  // Desktop / Tablet segmented track
  let html = `<div class="kb-nav-desktop-items flex items-center gap-1">`;

  // Primary links
  for (const item of config.primary) {
    html += `
      <a href="${item.route}" data-route-link="${item.route}" class="kb-nav-link" title="${esc(item.label)}">
        <sl-icon name="${item.icon}" aria-hidden="true"></sl-icon>
        <span>${esc(item.label)}</span>
      </a>`;
  }

  // Secondary links on desktop
  for (const item of config.secondary) {
    html += `
      <a href="${item.route}" data-route-link="${item.route}" class="kb-nav-link" title="${esc(item.label)}">
        <sl-icon name="${item.icon}" aria-hidden="true"></sl-icon>
        <span>${esc(item.shortLabel || item.label)}</span>
      </a>`;
  }

  // Dropdown menu (Create ▾ or Study ▾)
  if (config.dropdown) {
    html += `
      <sl-dropdown placement="bottom-end" distance="6" class="kb-nav-dropdown">
        <button slot="trigger" type="button" class="kb-nav-link kb-nav-dropdown-btn" aria-label="${esc(config.dropdown.label)} menu">
          <sl-icon name="${config.dropdown.icon}" aria-hidden="true"></sl-icon>
          <span>${esc(config.dropdown.label)}</span>
          <sl-icon name="chevron-down" class="text-xs ml-0.5 opacity-70"></sl-icon>
        </button>
        <sl-menu class="kb-nav-dropdown-menu">
          ${config.dropdown.items.map(it => `
            <sl-menu-item value="${it.route}">
              <sl-icon slot="prefix" name="${it.icon}"></sl-icon>
              ${esc(it.label)}
            </sl-menu-item>
          `).join('')}
        </sl-menu>
      </sl-dropdown>`;
  }

  html += `</div>`;

  // Mobile Bottom Bar (<768px): Up to 4 primary items + More button
  html += `<div class="kb-nav-mobile-items flex md:hidden items-center justify-around w-full h-full">`;
  const mobilePrimary = config.primary.slice(0, 4);
  for (const item of mobilePrimary) {
    html += `
      <a href="${item.route}" data-route-link="${item.route}" class="kb-nav-link kb-nav-mobile-link" title="${esc(item.label)}">
        <sl-icon name="${item.icon}" aria-hidden="true"></sl-icon>
        <span>${esc(item.label)}</span>
      </a>`;
  }
  html += `
    <button type="button" id="btn-kb-nav-more" class="kb-nav-link kb-nav-mobile-link" aria-label="More navigation options">
      <sl-icon name="three-dots" aria-hidden="true"></sl-icon>
      <span>More</span>
    </button>
  </div>`;

  container.innerHTML = html;

  // Wire dropdown click to router navigation
  container.querySelectorAll('.kb-nav-dropdown-menu').forEach(menu => {
    menu.addEventListener('sl-select', (e) => {
      const targetRoute = e.detail.item.value;
      if (targetRoute) {
        window.location.hash = targetRoute;
      }
    });
  });

  // Ensure More Drawer is mounted in overlays
  ensureMoreDrawer(role);

  // Wire More button
  const moreBtn = container.querySelector('#btn-kb-nav-more');
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      const drawer = document.getElementById('kb-nav-more-drawer');
      if (drawer) drawer.show();
    });
  }

  updateActiveNav(currentActiveRoute || window.location.hash || '#/');
}

function ensureMoreDrawer(role) {
  let overlays = document.getElementById('kb-nav-overlays');
  if (!overlays) {
    overlays = document.createElement('div');
    overlays.id = 'kb-nav-overlays';
    document.body.appendChild(overlays);
  }

  const existingDrawer = document.getElementById('kb-nav-more-drawer');
  if (existingDrawer) existingDrawer.remove();

  const config = NAV_CONFIG[role] || NAV_CONFIG.teacher;
  const drawer = document.createElement('sl-drawer');
  drawer.id = 'kb-nav-more-drawer';
  drawer.label = role === 'student' ? 'Student Menu' : 'Navigation & Tools';
  drawer.placement = 'bottom';
  drawer.style.setProperty('--size', 'auto');

  let itemsHtml = `<div class="p-4 space-y-4">`;

  // Secondary items
  if (config.secondary.length > 0) {
    itemsHtml += `<div class="space-y-1">
      <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Management</div>
      ${config.secondary.map(it => `
        <a href="${it.route}" class="flex items-center gap-3 p-3 rounded-xl hover:bg-slate-100 transition-colors text-slate-800 font-medium kb-drawer-link">
          <sl-icon name="${it.icon}" class="text-xl text-blue-600"></sl-icon>
          <span>${esc(it.label)}</span>
        </a>
      `).join('')}
    </div>`;
  }

  // Dropdown items (Create / Study tools)
  if (config.dropdown && config.dropdown.items.length > 0) {
    itemsHtml += `<div class="space-y-1 pt-2 border-t border-slate-100">
      <div class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">${esc(config.dropdown.label)} Tools</div>
      ${config.dropdown.items.map(it => `
        <a href="${it.route}" class="flex items-center gap-3 p-3 rounded-xl hover:bg-slate-100 transition-colors text-slate-800 font-medium kb-drawer-link">
          <sl-icon name="${it.icon}" class="text-xl text-indigo-600"></sl-icon>
          <span>${esc(it.label)}</span>
        </a>
      `).join('')}
    </div>`;
  }

  itemsHtml += `</div>`;
  drawer.innerHTML = itemsHtml;
  overlays.appendChild(drawer);

  // Close drawer on link click
  drawer.querySelectorAll('.kb-drawer-link').forEach(link => {
    link.addEventListener('click', () => {
      drawer.hide();
    });
  });
}

/**
 * Route matching logic: Finds most specific matching nav link.
 */
export function updateActiveNav(rawHash = window.location.hash || '#/') {
  currentActiveRoute = rawHash;
  const nav = document.getElementById('kb-app-nav');
  if (!nav) return;

  const cleanHash = rawHash.split('?')[0] || '#/';
  const links = Array.from(nav.querySelectorAll('a[data-route-link]'));

  let bestMatch = null;
  let bestMatchLength = -1;

  for (const link of links) {
    const route = link.getAttribute('data-route-link');
    if (!route) continue;

    // Exact match
    if (cleanHash === route) {
      bestMatch = link;
      bestMatchLength = 9999;
      break;
    }

    // Prefix match at path segment boundary
    if (route !== '#/' && (cleanHash.startsWith(route + '/') || cleanHash.startsWith(route + '?'))) {
      if (route.length > bestMatchLength) {
        bestMatch = link;
        bestMatchLength = route.length;
      }
    }
  }

  // Fallback to home only if exactly '#/' or empty
  if (!bestMatch && (cleanHash === '#/' || cleanHash === '#' || cleanHash === '')) {
    bestMatch = links.find(l => l.getAttribute('data-route-link') === '#/');
  }

  for (const link of links) {
    if (link === bestMatch) {
      link.classList.add('kb-nav-active');
      link.setAttribute('aria-current', 'page');
    } else {
      link.classList.remove('kb-nav-active');
      link.removeAttribute('aria-current');
    }
  }
}
