import { z } from 'zod';

// Zod v4 compiles parsers with `new Function` unless JIT is disabled; the app's CSP forbids eval.
// Import `z` from here (not from 'zod') so the setting is always applied first.
if (typeof z.config === 'function') z.config({ jitless: true });

export { z };
