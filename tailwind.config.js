/**
 * Tailwind build for KennisBoost Tools.
 *
 * Run `npm run build:css` after changing markup classes. The output
 * (css/tailwind.output.css) is committed so the app stays build-free at runtime.
 *
 * Every palette colour resolves through a CSS variable, with separate variable
 * namespaces for backgrounds, text and borders. That lets dark mode remap
 * `bg-blue-50` to a subtle tinted surface while `text-blue-700` becomes a
 * readable light tint, without touching any template markup.
 */
import twColors from 'tailwindcss/colors';
import plugin from 'tailwindcss/plugin';

const HUES = ['slate', 'red', 'orange', 'amber', 'yellow', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'];
const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];

// Dark-mode surfaces (kept in sync with --kb-* tokens in css/app.css)
const DARK_SURFACE = '#151e30';

const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
};
const triple = (hex) => hexToRgb(hex).join(' ');
const mix = (fg, bg, amount) => {
  const a = hexToRgb(fg);
  const b = hexToRgb(bg);
  return a.map((v, i) => Math.round(v * amount + b[i] * (1 - amount))).join(' ');
};

function lightVars() {
  const vars = {};
  for (const hue of HUES) {
    for (const s of SHADES) {
      const v = triple(twColors[hue][s]);
      vars[`--bg-${hue}-${s}`] = v;
      vars[`--fg-${hue}-${s}`] = v;
      vars[`--bd-${hue}-${s}`] = v;
    }
  }
  vars['--bg-white'] = '255 255 255';
  return vars;
}

function darkVars() {
  const vars = {};
  const slate = {
    bg: { 50: '#1a2438', 100: '#1f2a3f', 200: '#29354b', 300: '#344158', 400: '#475569' },
    fg: { 400: '#7f8ca3', 500: '#94a3b8', 600: '#aab6c8', 700: '#c8d1de', 800: '#e2e8f0', 900: '#f1f5f9', 950: '#f8fafc' },
    bd: { 50: '#1f2a3f', 100: '#232f45', 200: '#2b384f', 300: '#37445c', 400: '#4a586e' }
  };
  for (const [ns, map] of Object.entries(slate)) {
    for (const [s, hex] of Object.entries(map)) vars[`--${ns}-slate-${s}`] = triple(hex);
  }

  for (const hue of HUES.filter(h => h !== 'slate')) {
    const p = twColors[hue];
    // Tinted surfaces: blend the mid-tone into the dark card surface
    vars[`--bg-${hue}-50`] = mix(p['500'], DARK_SURFACE, 0.12);
    vars[`--bg-${hue}-100`] = mix(p['500'], DARK_SURFACE, 0.2);
    vars[`--bg-${hue}-200`] = mix(p['500'], DARK_SURFACE, 0.3);
    vars[`--bg-${hue}-300`] = mix(p['500'], DARK_SURFACE, 0.45);
    // Foreground: flip dark ink to light tints for contrast on dark surfaces
    vars[`--fg-${hue}-500`] = triple(p['400']);
    vars[`--fg-${hue}-600`] = triple(p['400']);
    vars[`--fg-${hue}-700`] = triple(p['300']);
    vars[`--fg-${hue}-800`] = triple(p['200']);
    vars[`--fg-${hue}-900`] = triple(p['100']);
    vars[`--fg-${hue}-950`] = triple(p['50']);
    // Borders: muted tinted hairlines
    vars[`--bd-${hue}-50`] = mix(p['500'], DARK_SURFACE, 0.18);
    vars[`--bd-${hue}-100`] = mix(p['500'], DARK_SURFACE, 0.24);
    vars[`--bd-${hue}-200`] = mix(p['500'], DARK_SURFACE, 0.32);
    vars[`--bd-${hue}-300`] = mix(p['500'], DARK_SURFACE, 0.45);
  }
  vars['--bg-white'] = triple(DARK_SURFACE);
  return vars;
}

function projectorVars() {
  // High-contrast projector mode: push muted ink to near-black, hairlines darker
  return {
    '--fg-slate-400': triple('#334155'),
    '--fg-slate-500': triple('#1e293b'),
    '--fg-slate-600': triple('#0f172a'),
    '--fg-slate-700': triple('#020617'),
    '--bd-slate-100': triple('#94a3b8'),
    '--bd-slate-200': triple('#64748b'),
    '--bd-slate-300': triple('#475569')
  };
}

const palette = (ns) => {
  const out = {
    inherit: 'inherit',
    current: 'currentColor',
    transparent: 'transparent',
    black: 'rgb(0 0 0 / <alpha-value>)',
    white: ns === 'bg' ? 'rgb(var(--bg-white) / <alpha-value>)' : 'rgb(255 255 255 / <alpha-value>)'
  };
  for (const hue of HUES) {
    out[hue] = {};
    for (const s of SHADES) out[hue][s] = `rgb(var(--${ns}-${hue}-${s}) / <alpha-value>)`;
  }
  // Aliases so `gray-*` markup follows the slate system
  out.gray = out.slate;
  return out;
};

export default {
  content: ['./index.html', './src/**/*.js'],
  // Module accent classes assembled at runtime (e.g. `text-${color}-600` on home cards)
  safelist: [{ pattern: /^(bg|text|border)-(blue|violet|rose|emerald|amber|purple)-(50|100|200|600|700)$/ }],
  darkMode: ['class', '.sl-theme-dark'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', '"JetBrains Mono"', '"SF Mono"', 'Menlo', 'Consolas', 'monospace']
      },
      boxShadow: {
        sm: 'var(--kb-shadow-sm)',
        DEFAULT: 'var(--kb-shadow-sm)',
        xs: 'var(--kb-shadow-xs)',
        md: 'var(--kb-shadow-md)',
        lg: 'var(--kb-shadow-lg)',
        xl: 'var(--kb-shadow-xl)'
      }
    },
    colors: palette('bg'),
    textColor: palette('fg'),
    borderColor: ({ theme }) => ({ ...palette('bd'), DEFAULT: 'rgb(var(--bd-slate-200) / <alpha-value>)' }),
    divideColor: palette('bd'),
    ringColor: palette('bg'),
    placeholderColor: palette('fg')
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ':root': lightVars(),
        'html.sl-theme-dark': darkVars(),
        'html.kb-theme-projector': projectorVars()
      });
    })
  ]
};
