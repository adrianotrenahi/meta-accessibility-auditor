// Builds the hosted Cavioo screens package from a private Cavioo checkout.
// Only the finished file is published; no Cavioo source enters this repository.
//
//   node tools/cavioo-ui/build.mjs --cavioo <Cavioo checkout> [--out dist/cavioo-ui.json]
//
// Cavioo's criteria, scoring, fix advice, server code and features this hackathon
// does not use are replaced by stand-ins while building (see STAND_INS below), so
// they never reach the package. Prompts are never imported by the screens at all.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '../..');
const ui = path.join(project, 'host/ui');
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const cavioo = arg('--cavioo') && path.resolve(arg('--cavioo'));
if (!cavioo || !existsSync(path.join(cavioo, 'apps/web/src')))
  throw Error('Pass --cavioo <path to a Cavioo checkout>.');
const out = path.resolve(arg('--out') ?? path.join(project, 'dist/cavioo-ui.json'));
const web = path.join(cavioo, 'apps/web');
const shared = path.join(cavioo, 'packages/shared/src');
const webRequire = createRequire(path.join(web, 'package.json'));
const { build } = createRequire(createRequire(path.join(cavioo, 'package.json')).resolve('tsx'))('esbuild');

/** Files whose contents must never ship: each is rebuilt from its export names only. */
export const STAND_INS = {
  // Cavioo's criteria, their wording, its scoring and its fix advice.
  [path.join(shared, 'utils/rubric.ts')]: 'rulebook',
  [path.join(shared, 'utils/fixText.ts')]: 'rulebook',
  [path.join(shared, 'utils/auditScore.ts')]: 'rulebook',
  [path.join(shared, 'utils/wcagConformance.ts')]: 'rulebook',
  [path.join(web, 'src/components/audits/report/rubricPresentation.ts')]: 'rulebook',
  [path.join(web, 'src/components/audits/report/wcagReport.ts')]: 'rulebook',
  // Server-only code.
  [path.join(web, 'src/lib/db.ts')]: 'server',
  [path.join(web, 'src/lib/notifications.server.ts')]: 'server',
  [path.join(web, 'src/lib/projectPeople.server.ts')]: 'server',
  // Cavioo features this hackathon build does not use.
  [path.join(web, 'src/lib/comments.ts')]: 'trimmed',
  [path.join(web, 'src/lib/workspaces.client.ts')]: 'trimmed',
  [path.join(web, 'src/lib/workspaceSwitch.ts')]: 'trimmed',
  [path.join(web, 'src/lib/freeTrialReport.ts')]: 'trimmed',
  [path.join(web, 'src/lib/trialBannerState.ts')]: 'trimmed',
  [path.join(web, 'src/lib/pdfExportReady.ts')]: 'trimmed',
};
const overrides = JSON.parse(readFileSync(path.join(here, 'stand-in-values.json'), 'utf8'));

/** Text with a space, 12 characters or longer, is wording or a reference and is blanked;
 * short labels, ids and colours stay. */
const isWording = (text) =>
  /\s/.test(text.trim()) && text.trim().length >= 12 && !/^(rgb|hsl|var\(|#|url\()/.test(text.trim());
/** A rulebook value keeps its shape so the screens load, but no wording, numbers or logic. */
function shapeOnly(value, name, seen = new Set()) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(isWording(value) ? '—' : value);
  if (typeof value === 'number') return '0';
  if (typeof value === 'boolean') return 'false';
  if (typeof value === 'function') return `(() => { __use(${JSON.stringify(name)}); return undefined; })`;
  if (value instanceof RegExp) return '/(?!)/';
  if (seen.has(value)) return 'null';
  seen.add(value);
  if (value instanceof Set) return `new Set([${[...value].map((v) => shapeOnly(v, name, seen)).join(',')}])`;
  if (value instanceof Map)
    return `new Map([${[...value].map(([k, v]) => `[${shapeOnly(k, name, seen)},${shapeOnly(v, name, seen)}]`).join(',')}])`;
  if (Array.isArray(value)) return `[${value.map((v) => shapeOnly(v, name, seen)).join(',')}]`;
  // Keys are ids and category names the screens look up by; only values carry wording.
  return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}:${shapeOnly(v, name, seen)}`).join(',')}}`;
}

/** The declared return type of `export function name(...)`, read from the source text. */
function returnTypeOf(source, from) {
  let i = source.indexOf('(', from), depth = 0;
  for (; i < source.length; i++) {
    if ('([{<'.includes(source[i])) depth++;
    else if (')]}>'.includes(source[i]) && source[i - 1] !== '=') depth--;
    if (depth === 0) break;
  }
  const rest = source.slice(i + 1);
  const colon = rest.match(/^\s*:\s*/);
  if (!colon) return '';
  let type = '', d = 0;
  for (const ch of rest.slice(colon[0].length)) {
    if (d === 0 && ch === '{' && /\S/.test(type) && !/[|&:,<(]\s*$/.test(type)) break;
    if ('([{<'.includes(ch)) d++;
    else if (')]}>'.includes(ch)) d--;
    type += ch;
  }
  return type.trim();
}
/** An empty value of a TypeScript type: lists, tables, flags and named objects keep their shape. */
function emptyOf(type, source, depth = 0) {
  const t = type.replace(/^Promise<(.*)>$/s, '$1').trim();
  if (/\|\s*null\b|\bnull\s*\|/.test(t)) return 'null';
  if (/\|\s*undefined\b|\bundefined\s*\|/.test(t) || t === 'void' || t === 'undefined') return 'undefined';
  if (/\[\]$|^(readonly\s+)?\w*Array<|^readonly\s|^\[/.test(t)) return '[]';
  if (/^(Readonly)?Map</.test(t)) return 'new Map()';
  if (/^(Readonly)?Set</.test(t)) return 'new Set()';
  if (t === 'string' || /^"[^"]*"(\s*\|\s*"[^"]*")*$/.test(t)) return '""';
  if (t === 'number') return '0';
  if (t === 'boolean') return 'false';
  if (/^Record</.test(t)) return '{}';
  if (t.startsWith('{')) return objectOf(t, source, depth);
  const named = depth < 2 && t.match(/^[A-Z][A-Za-z0-9_]*$/) &&
    source.match(new RegExp(`(?:interface|type)\\s+${t}\\s*(?:=\\s*)?(\\{[\\s\\S]*?\\n\\})`));
  return named ? objectOf(named[1], source, depth + 1) : 'undefined';
}
function objectOf(body, source, depth) {
  const fields = [...body.matchAll(/^\s{2}(?:readonly\s+)?([A-Za-z0-9_$]+)(\??):\s*([^;\n]+);?\s*$/gm)];
  return `{${fields.filter((f) => !f[2]).map((f) => `${f[1]}: ${emptyOf(f[3], source, depth)}`).join(', ')}}`;
}

/** A stand-in keeps a module's export names. Functions do nothing; a rulebook value
 * keeps only its shape (read here, on the builder's computer); others are empty. */
function standIn(file, reason, real) {
  const source = readFileSync(file, 'utf8');
  const key = path.relative(cavioo, file);
  const lines = [
    `// Stand-in (${reason}) for ${key}. The original never ships.`,
    'const __uses = (globalThis.__accessWalkStandIns ??= new Set());',
    `const __use = (name) => { if (!__uses.has(name)) { __uses.add(name); console.warn("Stand-in used: ${key} " + name); } };`,
  ];
  const names = new Set();
  for (const m of source.matchAll(/^export\s+(?:declare\s+)?(async\s+function|function\*?|class|const|let|var|enum)\s+([A-Za-z0-9_$]+)([^\n]*)/gm)) {
    const [, kind, name, rest] = m;
    if (names.has(name)) continue;
    names.add(name);
    const preset = overrides[key]?.[name];
    if (preset !== undefined) {
      lines.push(`export const ${name} = ${preset};`);
    } else if (/function/.test(kind)) {
      const empty = emptyOf(returnTypeOf(source, m.index), source);
      const value = /async/.test(kind) ? `Promise.resolve(${empty})` : empty;
      lines.push(`export function ${name}() { __use(${JSON.stringify(name)}); return ${value}; }`);
    } else if (kind === 'class') {
      lines.push(`export class ${name} extends Error {}`);
    } else if (real && name in real) {
      lines.push(`export const ${name} = ${shapeOnly(real[name], name)};`);
    } else {
      const value = (rest.split('=').slice(1).join('=') || source.slice(m.index + m[0].length, m.index + m[0].length + 40)).trim();
      const guess = /^(Object\.freeze\()?\[/.test(value) ? '[]'
        : /^(Object\.freeze\()?\{/.test(value) ? '{}'
        : /^new Set/.test(value) ? 'new Set()'
        : /^new Map/.test(value) ? 'new Map()'
        : /^["'`]/.test(value) ? '""'
        : /^-?\d/.test(value) ? '0'
        : /^(true|false)\b/.test(value) ? 'false'
        : /^(\(|async\s*\(|[A-Za-z0-9_$]+\s*=>)/.test(value) ? `(() => { __use(${JSON.stringify(name)}); return undefined; })`
        : 'undefined';
      lines.push(`export const ${name} = ${guess};`);
    }
  }
  return lines.join('\n');
}

const boundaries = {
  name: 'access-walk-boundaries',
  setup(b) {
    // Cavioo's shared package: read from source so stand-ins can replace files.
    b.onResolve({ filter: /^@cavioo\/shared(\/design|\/constants)?$/ }, (a) => ({
      path: path.join(shared, a.path === '@cavioo/shared' ? 'index.ts' : `${a.path.split('/').pop()}/index.ts`),
    }));
    b.onResolve({ filter: /^(@cavioo\/db|drizzle-orm)(\/.*)?$/ }, () => ({ path: 'server-only', namespace: 'empty' }));
    // One React for every screen: this project's own files would otherwise pick up a second copy.
    b.onResolve({ filter: /^(react|react-dom|zod)(\/.*)?$/ }, (a) =>
      a.pluginData?.single ? undefined : b.resolve(a.path, { resolveDir: web, kind: a.kind, pluginData: { single: true } }),
    );
    b.onLoad({ filter: /.*/, namespace: 'empty' }, () => ({ contents: 'export {};', loader: 'js' }));
    // The hackathon-written Meta helpers are built from this repository's copies.
    b.onResolve({ filter: /^@\/lib\/meta[A-Za-z]+$/ }, (a) => {
      const local = path.join(ui, 'lib', `${a.path.split('/').pop()}.ts`);
      return existsSync(local) ? { path: local } : undefined;
    });
    // A helper's own Cavioo import resolves against the Cavioo checkout.
    b.onResolve({ filter: /^\.\.?\// }, (a) => {
      if (!a.importer.startsWith(path.join(ui, 'lib') + path.sep)) return undefined;
      for (const ext of ['.ts', '.tsx']) if (existsSync(path.resolve(a.resolveDir, a.path + ext))) return undefined;
      for (const ext of ['.ts', '.tsx'])
        if (existsSync(path.join(web, 'src/lib', a.path + ext))) return { path: path.join(web, 'src/lib', a.path + ext) };
      return undefined;
    });
    b.onLoad({ filter: /\.tsx?$/ }, (a) =>
      STAND_INS[a.path] ? { contents: standIn(a.path, STAND_INS[a.path], reals[a.path]), loader: 'ts' } : undefined,
    );
  },
};
/** Reads a rulebook file's real exports on this computer, only to copy their shape. */
async function realExports(file) {
  const one = await build({
    entryPoints: [file],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    alias: { '@': path.join(web, 'src') },
    nodePaths: [path.join(web, 'node_modules'), path.join(cavioo, 'node_modules')],
    plugins: [{ name: 'shared-source', setup: (b) => b.onResolve({ filter: /^@cavioo\/shared(\/design|\/constants)?$/ }, (a) => ({
      path: path.join(shared, a.path === '@cavioo/shared' ? 'index.ts' : `${a.path.split('/').pop()}/index.ts`),
    })) }],
    logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(one.outputFiles[0].contents).toString('base64')}`);
}
const reals = {};
for (const [file, reason] of Object.entries(STAND_INS)) if (reason === 'rulebook') reals[file] = await realExports(file);

const common = {
  bundle: true,
  write: false,
  jsx: 'automatic',
  legalComments: 'none',
  alias: {
    '@': path.join(web, 'src'),
    'next/image': path.join(ui, 'next-shim.tsx'),
    'next/navigation': path.join(ui, 'funnel-navigation.tsx'),
    'next/link': path.join(ui, 'funnel-link.tsx'),
    '@clerk/nextjs': path.join(ui, 'funnel-account.tsx'),
  },
  nodePaths: [path.join(web, 'node_modules'), path.join(cavioo, 'node_modules')],
  plugins: [boundaries],
  metafile: true,
  logLevel: 'warning',
};

const browser = await build({
  ...common,
  entryPoints: [path.join(ui, 'funnel-client.tsx')],
  outdir: path.join(project, 'dist/.cavioo-ui'),
  platform: 'browser',
  format: 'iife',
  minify: !process.argv.includes('--readable'),
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
});
const helpers = await build({
  ...common,
  stdin: {
    contents: [
      'export {metaJourneyProgress} from "@/lib/metaJourney";',
      'export {readMetaHistory} from "@/lib/metaHistory";',
      'export {hostSnapshotSchema,projectMetaWalk} from "@/lib/metaWalkHost";',
      'export {metaThoughtDelta} from "@/lib/metaActivity";',
      'export {metaLiveFrameSchema} from "@/lib/metaLiveFrame";',
      'export {readOptionalMetaKeyboardEvidence} from "@/lib/metaKeyboardEvidence";',
      'export {readOptionalMetaAssessment,META_ASSESSMENT_UNAVAILABLE} from "@/lib/metaAssessment";',
    ].join('\n'),
    resolveDir: ui,
    loader: 'ts',
  },
  platform: 'node',
  format: 'esm',
  minify: !process.argv.includes('--readable'),
});

const files = {};
const add = (name, bytes, type) => (files[name] = { type, base64: Buffer.from(bytes).toString('base64') });
const fontSpecs = [
  ['Poppins', 'Poppins-500-latin.woff2', '500'],
  ['DM Sans', 'DMSans-latin.woff2', '400 700'],
  ['Material Symbols Outlined', 'MaterialSymbolsOutlined.ttf', '100 700'],
];
let fonts = '';
for (const [name, file, weight] of fontSpecs) {
  add(`/fonts/${file}`, readFileSync(path.join(cavioo, 'apps/extension/public/fonts', file)), file.endsWith('ttf') ? 'font/ttf' : 'font/woff2');
  fonts += `@font-face{font-family:'${name}';font-weight:${weight};src:url('/fonts/${file}')}\n`;
}
for (const tone of ['ink', 'paper']) {
  const name = `cavioo-wordmark-l5-${tone}.svg`;
  add(`/brand/${name}`, readFileSync(path.join(web, 'public/brand', name)), 'image/svg+xml');
}
const css = await webRequire('postcss')([
  webRequire('tailwindcss')({
    ...webRequire('./tailwind.config.js'),
    content: [path.join(web, 'src/**/*.{ts,tsx}'), path.join(ui, '**/*.{ts,tsx}')],
  }),
]).process(readFileSync(path.join(web, 'src/app/globals.css'), 'utf8'), { from: undefined });
const js = browser.outputFiles.find((f) => f.path.endsWith('.js'));
add('/app.js', js.contents, 'text/javascript');
add('/app.css', fonts + css.css + browser.outputFiles.filter((f) => f.path.endsWith('.css')).map((f) => f.text).join('\n'), 'text/css');
add('/', '<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cavioo · Access Walk</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>', 'text/html');

// The list of every Cavioo file inside the package, for review.
const included = [...new Set([...Object.keys(browser.metafile.inputs), ...Object.keys(helpers.metafile.inputs)])]
  .map((f) => path.resolve(f))
  .filter((f) => f.startsWith(cavioo) && !f.includes(`${path.sep}node_modules${path.sep}`))
  .map((f) => ({ file: path.relative(cavioo, f), standIn: STAND_INS[f] ?? null, bytes: STAND_INS[f] ? 0 : readFileSync(f).length }))
  .sort((a, b) => b.bytes - a.bytes);
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out.replace(/\.json$/, '.contents.json'), JSON.stringify(included, null, 1));
const caviooCommit = execFileSync('git', ['-C', cavioo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const pkg = JSON.stringify({
  format: 'access-walk/cavioo-ui-v1',
  notice: 'Cavioo screens (prior work, not hackathon code). Built from a private Cavioo checkout; Cavioo criteria, scoring, advice, prompts and server code are not included.',
  builtFrom: { cavioo: caviooCommit, project: execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() },
  files,
  hostLib: Buffer.from(helpers.outputFiles[0].contents).toString('base64'),
});
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, pkg);
console.log(JSON.stringify({ out, bytes: pkg.length, sha256: createHash('sha256').update(pkg).digest('hex') }));
