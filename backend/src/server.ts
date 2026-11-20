import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';

import { createApp } from './app.js';
import { ChatStore } from './chat-store.js';
import { ClaudeCaller } from './claude.js';
import { loadConfig } from './config.js';
import { ToolHub } from './hub.js';
import { createSessionCheck } from './session.js';
import { createSigner } from './signing.js';

const config = loadConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
const hub = new ToolHub({ apps: config.apps, signer: createSigner(config.signingKey), owner: config.owner });
// The hub is kept fresh here for the AI shell (#612); the health check shows which apps answer.
await hub.start(config.refreshMs);

// The AI shell needs the sign-in service to know who asks; without AUTH_INTERNAL_URL /api/chat is not served.
const caller = config.anthropicApiKey
  ? new ClaudeCaller({ client: new Anthropic({ apiKey: config.anthropicApiKey }), db: pool, monthlyTokenLimit: config.monthlyTokenLimit })
  : undefined;
const chat = config.authUrl
  ? { session: createSessionCheck({ authUrl: config.authUrl }), store: new ChatStore(pool), caller, hub, owner: config.owner, model: config.model, rootDomain: config.rootDomain }
  : undefined;
if (!chat) console.error('WARNING: AUTH_INTERNAL_URL is not set, so /api/chat is off');
else if (config.owner === 'owner') console.error('WARNING: AI_OWNER_ID is not set, so no one may use /api/chat');

const app = createApp({ ping: async () => void (await pool.query('select 1')), apps: () => hub.apps(), chat });
app.listen(config.port, () => console.log(`ai http://localhost:${config.port} (tools from: ${hub.apps().join(', ') || 'no app yet'})`));
