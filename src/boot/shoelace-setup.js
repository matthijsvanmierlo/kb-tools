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
['dialog', 'drawer', 'alert', 'button'].forEach((name) => {
  import(`../../vendor/shoelace/components/${name}/${name}.js`).catch(() => {});
});
