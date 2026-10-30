// Proves the hosted package carries none of Cavioo's private text.
//   node tools/cavioo-ui/leak-check.mjs --cavioo <Cavioo checkout> --package <cavioo-ui.json>
// Every string literal in the private files below is decoded (escapes, quotes,
// line breaks), split into lines, and each line of 24+ characters must be absent
// from the package in every form a bundle can hold it: as written, JSON-escaped,
// and with non-ASCII characters escaped. Exit code 1 lists any that leaked.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const cavioo = path.resolve(arg('--cavioo'));
const pkg = JSON.parse(readFileSync(path.resolve(arg('--package')), 'utf8'));
const shared = path.join(cavioo, 'packages/shared/src');
const web = path.join(cavioo, 'apps/web/src');
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) && !/test/.test(name) ? [full] : [];
  });
const privateFiles = [
  ...['rubric', 'fixText', 'auditScore', 'wcagConformance'].map((f) => path.join(shared, `utils/${f}.ts`)),
  path.join(web, 'components/audits/report/rubricPresentation.ts'),
  path.join(web, 'components/audits/report/wcagReport.ts'),
  ...walk(path.join(shared, 'prompts')),
  ...walk(path.join(shared, 'llm')),
  ...walk(path.join(shared, 'analyst')),
  ...['db', 'notifications.server', 'projectPeople.server', 'comments', 'workspaces.client', 'freeTrialReport', 'trialBannerState', 'pdfExportReady'].map((f) =>
    path.join(web, `lib/${f}.ts`),
  ),
];
const text = [
  ...Object.values(pkg.files).filter((f) => /javascript|css|html/.test(f.type)).map((f) => Buffer.from(f.base64, 'base64').toString('utf8')),
  Buffer.from(pkg.hostLib, 'base64').toString('utf8'),
].join('\n');
const allowed = JSON.parse(readFileSync(new URL('./leak-allow.json', import.meta.url), 'utf8'));

/** The value a source literal stands for, as the browser would see it. */
function decode(raw, quote) {
  const body = raw
    .replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1')
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\(['`$])/g, '$1')
    .replace(/(^|[^\\])"/g, '$1\\"')
    .replace(/\n/g, '\\n');
  try {
    return JSON.parse(`"${body}"`);
  } catch {
    return quote === '`' ? raw : null;
  }
}
/** Every way a bundler may have written the same text. */
const forms = (value) => {
  const json = JSON.stringify(value).slice(1, -1);
  return [value, json, json.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)];
};
const leaks = new Set();
let checked = 0;
for (const file of privateFiles) {
  const source = readFileSync(file, 'utf8');
  const literals = [...source.matchAll(/(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => [m[2], m[1]]);
  for (const m of source.matchAll(/`((?:\\.|[^`\\])*)`/g))
    for (const piece of m[1].split(/\$\{[^}]*\}/)) literals.push([piece, '`']);
  for (const [raw, quote] of literals) {
    const value = decode(raw, quote);
    if (value === null) continue;
    for (const line of value.split('\n')) {
      const piece = line.trim();
      // Colours are not wording.
      if (piece.length < 24 || allowed[piece] || /^(rgb|hsl)a?\(|^var\(--/.test(piece)) continue;
      checked++;
      if (forms(piece).some((form) => text.includes(form))) leaks.add(`${path.relative(cavioo, file)}: ${piece.slice(0, 80)}`);
    }
  }
}
console.log(JSON.stringify({ privateFiles: privateFiles.length, textsChecked: checked, leaked: leaks.size }));
for (const leak of [...leaks].slice(0, 40)) console.log('LEAK', leak);
process.exitCode = leaks.size ? 1 : 0;
