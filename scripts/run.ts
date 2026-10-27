import { startServer } from '../server/index.js';
const mode = process.argv.includes('live') ? 'live' : 'offline';
if (mode === 'live')
  throw Error(
    'This command starts saved demonstrations only. Paid tests use the controlled proof script with its bounded approval.',
  );
const app = await startServer(4323, undefined, false);
try {
  const run = await app.runner.start({
    mode: 'offline',
    headless: process.argv.includes('--headless'),
    voiceOver: !process.argv.includes('--headless'),
  });
  console.log('Started offline run ' + run.id);
  while (app.runner.active) await new Promise((r) => setTimeout(r, 500));
  const saved = app.store.run(run.id);
  console.log(
    JSON.stringify(
      {
        run: saved,
        records: app.store.records(run.id).length,
        published: app.store.published(run.id).length,
        usage: app.store.usage(run.id),
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
