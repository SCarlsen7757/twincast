// Local-only fixture preview: compile with npm test, then run this script.
import { createBoardServer } from '../dist/src/server.js';
import { closeDb, openDb, upsertItems, setMeta } from '../dist/src/db.js';
import { refreshSnapshot } from '../dist/src/poller.js';
import { config } from '../dist/src/config.js';

config.heroCount = 8;
config.railCount = 8;
const server = createBoardServer();
server.prependListener('request', (req) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/tv') return;
  const scene = url.searchParams.get('scene') || 'default';
  closeDb();
  openDb(':memory:');
  const count = scene === 'empty' ? 0 : scene === 'single' ? 1 : 8;
  upsertItems(
    Array.from({ length: count }, (_, i) => ({
      guid: 'visual-' + i,
      title: 'Fixture',
      name:
        scene === 'long'
          ? 'Condition Monitoring and Distributed Motion Control Engineering Tools'
          : [
              'Condition Monitoring',
              'Motion Control',
              'Automation Interface',
              'Analytics Runtime',
              'Vision',
              'OPC UA',
              'C++ Engineering',
              'Safety',
            ][i],
      codes: 'TF' + (3600 + i),
      family: 'TF',
      version: scene === 'long' ? '4026.12345.67890.12345' : '3.4.' + (10 - i),
      channel: i % 2 ? 'testing' : 'stable',
      link: scene === 'missing' ? '' : 'https://example.com/download',
      description:
        'Synthetic release fixture for dashboard layout verification. Includes performance improvements and updated engineering tools.',
      pub_date: Math.floor(Date.now() / 1000) - i * 86400,
    })),
  );
  setMeta({
    channel_title: 'TwinCAT Release Feed',
    last_success: count ? Math.floor(Date.now() / 1000) - (scene === 'stale' ? 86400 : 0) : '',
  });
  refreshSnapshot();
});
server.listen(8097, '127.0.0.1', () =>
  console.log(
    'Preview: http://127.0.0.1:8097/tv?scene=default (empty, single, long, missing, stale)',
  ),
);
process.on('SIGINT', () => {
  server.close();
  closeDb();
});
