import pg from 'pg';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { ToolHub } from './hub.js';
import { createSigner } from './signing.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
const hub = new ToolHub({ apps: config.apps, signer: createSigner(config.signingKey), owner: config.owner });
// The hub is kept fresh here for the AI shell (#612); the health check shows which apps answer.
await hub.start(config.refreshMs);

const app = createApp({ ping: async () => void (await pool.query('select 1')), apps: () => hub.apps() });
app.listen(config.port, () => console.log(`ai http://localhost:${config.port} (tools from: ${hub.apps().join(', ') || 'no app yet'})`));
