// The MCP server over stdio, for Claude Code or Claude Desktop on the owner's PC through SSH (ADR-0017 stage 1):
//   ssh ubuntu@<server> docker exec -i shared-ai-api-1 node dist/mcp-stdio.js
// The SSH key is the authentication. Every call token names the client `stdio` and grants the called app's read and
// write scopes; the app still checks the scope and writes its audit row. stdout carries only MCP messages, so logs
// go to stderr. It needs no database.
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadHubConfig } from './config.js';
import { ToolHub } from './hub.js';
import { createMcpServer } from './mcp.js';
import { createSigner } from './signing.js';

const config = loadHubConfig();
const hub = new ToolHub({ apps: config.apps, signer: createSigner(config.signingKey), owner: config.owner });
await hub.start(config.refreshMs);
console.error(`shared-ai mcp: ${hub.list().length} tools from ${hub.apps().join(', ') || 'no app'}`);

serveStdio(() => createMcpServer(hub, 'stdio').server, {
  onerror: (err) => console.error(`shared-ai mcp: ${err.message}`),
});
