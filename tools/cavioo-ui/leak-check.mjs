// Proves the hosted package carries none of Cavioo's private text.
//   node tools/cavioo-ui/leak-check.mjs --cavioo <Cavioo checkout> --package <cavioo-ui.json>
// Every string literal of 24+ characters in the private files below must be absent
// from the package's screens and helpers. Exit code 1 lists any that leaked.
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
const leaks = [];
let checked = 0;
for (const file of privateFiles) {
  const source = readFileSync(file, 'utf8');
  for (const m of source.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n]){24,}?)\1/g)) {
    const literal = m[2];
    if (/\$\{/.test(literal)) continue; // a template's pieces are checked below
    checked++;
    if (text.includes(literal) && !allowed[literal]) leaks.push(`${path.relative(cavioo, file)}: ${literal.slice(0, 80)}`);
  }
  for (const m of source.matchAll(/`([^`]{24,})`/g))
    for (const piece of m[1].split(/\$\{[^}]*\}/).filter((p) => p.trim().length >= 24)) {
      checked++;
      if (text.includes(piece) && !allowed[piece.trim()]) leaks.push(`${path.relative(cavioo, file)}: ${piece.slice(0, 80)}`);
    }
}
console.log(JSON.stringify({ privateFiles: privateFiles.length, textsChecked: checked, leaked: leaks.length }));
for (const leak of leaks.slice(0, 40)) console.log('LEAK', leak);
process.exitCode = leaks.length ? 1 : 0;
