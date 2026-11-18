// The integrated MCP server (ADR-0017): one server that lists every app's tools under `<app>__<tool>` and forwards a
// call to the app through the hub. The app validates the input, checks the scope from the signed token, and writes
// the audit row, so this server passes the input through unchanged.
import {
  type CallToolResult,
  fromJsonSchema,
  type JsonSchemaValidator,
  type jsonSchemaValidator,
  McpServer,
  type RegisteredTool,
} from '@modelcontextprotocol/server';

import type { HubTool, ToolHub } from './hub.js';
import { ToolCallError } from './hub.js';

export const SERVER_INFO = { name: 'shared-ai', version: '1.0.0' };

// The app checks the input with its own Zod schema; the MCP layer must not reject what the app would accept.
const passThrough: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

const asText = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

/** Runs one hub tool and turns the answer or the app's error into an MCP tool result. */
export async function callHubTool(hub: ToolHub, name: string, input: unknown, client: string): Promise<CallToolResult> {
  try {
    const result = await hub.call(name, input, { client });
    return { content: [{ type: 'text', text: asText(result) }] };
  } catch (err) {
    // A refused or failed call is a tool error the model can read, not a protocol error.
    const message = err instanceof ToolCallError ? err.message : `Tool call failed: ${err instanceof Error ? err.message : String(err)}`;
    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

function config(tool: HubTool) {
  return {
    description: `[${tool.app}] ${tool.description}`,
    // MCP tool input is always an object; the apps' Zod schemas are objects already.
    inputSchema: fromJsonSchema({ type: 'object', ...tool.inputSchema }, passThrough),
    annotations: { ...tool.annotations, title: `${tool.app}: ${tool.tool}` },
  };
}

/**
 * Builds an MCP server that mirrors the hub: tools are added, updated, and removed when a hub refresh changes the
 * list. `client` goes into every call token (`stdio` for the SSH entry point).
 */
export function createMcpServer(hub: ToolHub, client: string) {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: { listChanged: true } } });
  const registered = new Map<string, { tool: HubTool; handle: RegisteredTool }>();

  const sync = () => {
    const current = new Map(hub.list().map((t) => [t.name, t]));
    for (const [name, entry] of registered) {
      if (!current.has(name)) {
        entry.handle.remove();
        registered.delete(name);
      }
    }
    for (const [name, tool] of current) {
      const known = registered.get(name);
      if (known && JSON.stringify(known.tool) === JSON.stringify(tool)) continue;
      known?.handle.remove();
      registered.delete(name);
      // One tool the SDK refuses must not keep the others out.
      try {
        const handle = server.registerTool(name, config(tool), async (input: unknown) => callHubTool(hub, name, input, client));
        registered.set(name, { tool, handle });
      } catch (err) {
        console.error(`shared-ai mcp: tool ${name} left out: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  sync();
  const unsubscribe = hub.onChange(sync);
  return { server, close: unsubscribe };
}
