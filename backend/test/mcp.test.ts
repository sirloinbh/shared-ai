// Runs the real stdio entry point (src/mcp-stdio.ts) as a child process against a fake app, the way Claude Code runs
// it through `ssh ... docker exec -i shared-ai-api-1 node dist/mcp-stdio.js`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import { createSigner } from '../src/signing.js';
import { startFakeApp } from './fake-app.js';

const backend = path.join(import.meta.dirname, '..');
const privatePem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKey = createPublicKey(createSigner(privatePem).publicKeyPem());

function startStdio(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/mcp-stdio.ts'], {
    cwd: backend,
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  const notifications: string[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as { id?: number; method?: string };
    if (message.id !== undefined && pending.has(message.id)) pending.get(message.id)!(message);
    else if (message.method) notifications.push(message.method);
  });
  let next = 1;
  const request = (method: string, params: unknown = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = next++;
      const timer = setTimeout(() => reject(new Error(`${method} timed out; stderr: ${stderr}`)), 15_000);
      pending.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const notify = (method: string) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  const stop = () =>
    new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.stdin.end();
      setTimeout(() => child.kill(), 3_000).unref();
    });
  return { request, notify, stop, notifications, stderr: () => stderr };
}

test('the stdio MCP server lists app tools as <app>__<tool> and calls them through the hub', async () => {
  const app = await startFakeApp('workout-memo', publicKey);
  const mcp = startStdio({ AI_TOOLS_SIGNING_KEY: privatePem.replace(/\n/g, '\\n'), AI_TOOL_APPS: `workout-memo=${app.url}`, AI_OWNER_ID: 'user-1' });
  try {
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal((init.result as { serverInfo: { name: string } }).serverInfo.name, 'shared-ai');
    mcp.notify('notifications/initialized');

    const list = (await mcp.request('tools/list')).result as { tools: { name: string; annotations?: Record<string, unknown>; inputSchema: Record<string, unknown> }[] };
    const names = list.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['workout_memo__add_workout', 'workout_memo__list_workouts']);
    const listTool = list.tools.find((t) => t.name === 'workout_memo__list_workouts')!;
    assert.equal(listTool.annotations?.readOnlyHint, true);
    assert.deepEqual(listTool.inputSchema.required, ['from', 'to'], 'the app schema is passed through');

    const call = (await mcp.request('tools/call', { name: 'workout_memo__add_workout', arguments: { date: '2026-11-18', title: 'Legs' } })).result as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
    assert.notEqual(call.isError, true, JSON.stringify(call));
    assert.deepEqual(JSON.parse(call.content[0]!.text), { tool: 'add_workout', echo: { date: '2026-11-18', title: 'Legs' } });
    assert.deepEqual(app.state.calls[0]?.caller, { owner: 'user-1', client: 'stdio', scopes: ['workout-memo:write'] });

    // The app's own refusal reaches the model as a tool error, not a protocol error.
    app.state.down = true;
    const failed = (await mcp.request('tools/call', { name: 'workout_memo__list_workouts', arguments: { from: '2026-11-01', to: '2026-11-18' } })).result as {
      content: { text: string }[];
      isError?: boolean;
    };
    assert.equal(failed.isError, true);
    assert.match(failed.content[0]!.text, /workout-memo: down/);
  } finally {
    await mcp.stop();
    await app.close();
  }
});
