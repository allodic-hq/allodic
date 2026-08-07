// Zero-dependency terminal color for the allodic CLI. Semantic, not
// decorative — the same system the storefront and website use:
//   green = verified / passing      red   = failed / refused
//   yellow(~) = warning             gold  = money
//   cyan  = URLs & commands to run  dim   = evidence & secondary detail
//
// Colors appear only on a real terminal. Piped output (scripts, greps, CI,
// e2e assertions) stays byte-clean, `NO_COLOR` is honored per no-color.org,
// and ALLODIC_COLOR=1/0 force-overrides for tests and unusual setups.
const enabled = (() => {
  if (process.env.ALLODIC_COLOR === '0') return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.ALLODIC_COLOR === '1') return true;
  return Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb';
})();

export const colorEnabled = enabled;
const wrap = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  green: wrap('32'),
  red: wrap('31'),
  yellow: wrap('33'),
  gold: wrap('33;1'),
  cyan: wrap('36'),
  dim: wrap('2'),
  bold: wrap('1'),
};

// Raw codes for manual layout code (e.g. the sales receipt box), empty when
// color is off so width math and piped output stay clean.
export const codes = enabled
  ? { g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', R: '\x1b[0m' }
  : { g: '', d: '', b: '', R: '' };

/** Paint a whole status line, one place for every message:
 *  - marks: ✓ green, ✗ red, leading ~ yellow, leading = dim
 *  - EVIDENCE dimming: on ✓/~ lines, everything after the first double-space
 *    separator is secondary detail (digests, engines, timestamps) and renders
 *    dim — instant hierarchy across publish/add/verify with zero per-site
 *    edits. Wording is untouched, so piped output and greps never change. */
export function paintMark(s) {
  if (!enabled || typeof s !== 'string') return s;
  let out = s
    .replace(/✓/g, '\x1b[32m✓\x1b[0m')
    .replace(/✗/g, '\x1b[31m✗\x1b[0m')
    .replace(/^(\s*)~(?=\s)/, (_, sp) => `${sp}\x1b[33m~\x1b[0m`)
    .replace(/^(\s*)=(?=\s)/, (_, sp) => `${sp}\x1b[2m=\x1b[0m`);
  if (/^\s*[✓~]/.test(s) && !s.includes('\x1b[2m')) { // sites that dim explicitly own their own hierarchy
    const i = out.indexOf('  ', out.search(/\S/) + 1);
    if (i > 0 && !out.slice(i).startsWith('  \x1b[2m')) {
      out = `${out.slice(0, i)}  \x1b[2m${out.slice(i + 2).replace(/\x1b\[0m/g, '\x1b[0m\x1b[2m')}\x1b[0m`;
    }
  }
  return out;
}

/** A dim section rule: ── label ─────────… (fixed 46 cols). */
export function rule(label = '') {
  const body = label ? `── ${label} ` : '';
  const line = body + '─'.repeat(Math.max(2, 46 - body.length));
  return enabled ? `\x1b[2m${line}\x1b[0m` : line;
}
