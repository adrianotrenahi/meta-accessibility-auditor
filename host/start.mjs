// Starts Cavioo's audits page on this computer, signed in as Testing Account.
//   npm run audits                    controlled example shop, saved responses, no key
//   npm run audits -- --public-websites   real websites; needs META_API_KEY in .env and a
//                                         spend-approval.json (see README)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMetaFunnelProof } from './funnel-server.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback);
const publicWebsites = process.argv.includes('--public-websites');
try {
  const page = await startMetaFunnelProof({
    engineRoot: project,
    dataDirectory: path.resolve(arg('--data', path.join(project, 'data/audits'))),
    port: Number(arg('--port', 4346)),
    publicWebsites,
    engineWorkingDirectory: project,
  });
  console.log(`Cavioo audits page (Testing Account, ${publicWebsites ? 'real websites' : 'controlled example'}): ${page.url}/audits`);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => void page.close().then(() => process.exit()));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
