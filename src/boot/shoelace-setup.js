// Shoelace derives its base path from the autoloader's <script src>. A relative src yields a bare
// path ("vendor/shoelace") that dynamic import() treats as a package name, so components never
// load. Set an absolute base path first (works from any deployment sub-path), then start the
// autoloader — a static import would be hoisted above setBasePath().
import { setBasePath } from '../../vendor/shoelace/utilities/base-path.js';

setBasePath(new URL('../../vendor/shoelace/', import.meta.url).href);
await import('../../vendor/shoelace/shoelace-autoloader.js');

// The autoloader only defines a component once it sees the tag in the DOM. Components the app
// creates in code and immediately calls methods on (dialog.show(), alert.toast()) are defined
// up front so those calls never hit an un-upgraded element.
const CORE_COMPONENTS = ['dialog', 'drawer', 'alert', 'button', 'icon', 'input', 'select', 'dropdown', 'menu', 'menu-item', 'tab-group', 'tab', 'tab-panel', 'badge', 'tooltip'];

export const shoelaceReady = Promise.all([
  ...CORE_COMPONENTS.map((name) => import(`../../vendor/shoelace/components/${name}/${name}.js`).catch(() => {})),
  typeof customElements !== 'undefined' ? customElements.whenDefined('sl-dialog') : Promise.resolve(),
  typeof customElements !== 'undefined' ? customElements.whenDefined('sl-button') : Promise.resolve()
]);

export async function ensureDialogReady(dialogEl) {
  await shoelaceReady;
  if (typeof customElements !== 'undefined' && !customElements.get('sl-dialog')) {
    await customElements.whenDefined('sl-dialog').catch(() => {});
  }
  return dialogEl;
}

// Global safeguard: Shoelace child controls (<sl-select>, <sl-dropdown>, <sl-popup>, <sl-tooltip>)
// dispatch 'sl-hide', 'sl-after-hide', and 'sl-request-close' with bubbles: true when closed/selected.
// When nested inside an <sl-dialog> or <sl-drawer>, these child events must not bubble to the modal
// container where they would erroneously trigger modal teardown, removal, or rejection.
if (typeof window !== 'undefined') {
  const CHILD_POPUP_TAGS = new Set([
    'SL-SELECT',
    'SL-DROPDOWN',
    'SL-POPUP',
    'SL-TOOLTIP',
    'SL-MENU',
    'SL-COLOR-PICKER'
  ]);

  ['sl-hide', 'sl-after-hide', 'sl-request-close'].forEach((eventName) => {
    window.addEventListener(
      eventName,
      (e) => {
        const targetTag = e.target?.tagName?.toUpperCase?.();
        if (CHILD_POPUP_TAGS.has(targetTag)) {
          const parentModal = e.target?.closest?.('sl-dialog, sl-drawer');
          if (parentModal && e.target !== parentModal) {
            e.stopPropagation();
          }
        }
      },
      true // capture phase to intercept before bubbling to parent dialog listeners
    );
  });
}

