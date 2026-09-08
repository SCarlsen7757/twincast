/* One-shot poll, for cron, debugging, or warming a fresh volume. */
import { openDb, closeDb, countItems } from './db.js';
import { pollOnce } from './poller.js';

openDb();
const r = await pollOnce();
console.log(JSON.stringify({ ...r, items: countItems() }, null, 2));
closeDb();
process.exit(r.status === 'error' ? 1 : 0);
