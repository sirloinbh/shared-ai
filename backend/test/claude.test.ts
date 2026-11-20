import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import Anthropic from '@anthropic-ai/sdk';

import { BudgetExceededError, ClaudeCaller, errorCode, type MessagesClient } from '../src/claude.js';
import { type Db, MIGRATIONS } from '../src/db.js';
import { ToolHub } from '../src/hub.js';
import { claudeTools, runToolLoop } from '../src/loop.js';
import { createSigner } from '../src/signing.js';
import { monthStart, monthTokens } from '../src/usage.js';
import { startFakeApp } from './fake-app.js';

type Row = Record<string, unknown> & { created_at: Date };

/** The two ai_usage queries of usage.ts over an in-memory table; `now` stamps new rows. */
function fakeDb(now: () => Date = () => new Date()) {
  const rows: Row[] = [];
  const db: Db = {
    query: async <R>(text: string, values: unknown[] = []) => {
      if (/^\s*insert into ai_usage/i.test(text)) {
        const keys = ['conversation_id', 'app', 'page', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'latency_ms', 'stop_reason', 'tool_calls', 'error_code'];
        rows.push({ ...Object.fromEntries(keys.map((k, i) => [k, values[i]])), created_at: now() });
        return { rows: [] as R[] };
      }
      if (/sum\(input_tokens \+ output_tokens \+ cache_read_tokens \+ cache_write_tokens\)/.test(text)) {
        const since = values[0] as Date;
        const total = rows
          .filter((r) => r.created_at >= since)
          .reduce((n, r) => n + Number(r.input_tokens) + Number(r.output_tokens) + Number(r.cache_read_tokens) + Number(r.cache_write_tokens), 0);
        return { rows: [{ total: rows.length ? String(total) : null }] as R[] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  return { db, rows };
}

function message(partial: Omit<Partial<Anthropic.Message>, 'usage'> & { usage?: Partial<Anthropic.Usage> }): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text: 'ok', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    ...partial,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, ...partial.usage } as Anthropic.Usage,
  } as Anthropic.Message;
}

/** A Claude client that answers from a script and counts its calls. No real key, no network. */
function fakeClient(answers: (Anthropic.Message | Error)[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (params) => {
        requests.push(structuredClone(params));
        const next = answers.shift();
        if (!next) throw new Error('no scripted answer left');
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
  return { client, requests };
}

const params = { model: 'claude-opus-5-5', max_tokens: 1000, messages: [{ role: 'user' as const, content: 'hi' }] };

test('the ai_usage table has the ADR-0019 fields, a time index, and no prompt or answer text', () => {
  const sql = MIGRATIONS.map((m) => m.sql).join('\n');
  for (const column of ['conversation_id', 'app', 'page', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'latency_ms', 'stop_reason', 'tool_calls', 'error_code']) {
    assert.match(sql, new RegExp(`\\b${column}\\b`), column);
  }
  assert.match(sql, /create index ai_usage_created_at on ai_usage \(created_at\)/);
  assert.doesNotMatch(sql, /\b(prompt|answer|content|message)\b/i);
});

test('each Claude request leaves one usage row with the tokens from usage', async () => {
  const { db, rows } = fakeDb();
  const toolUse = message({
    stop_reason: 'tool_use',
    content: [
      { type: 'tool_use', id: 't1', name: 'a__b_c', input: {}, caller: { type: 'direct' } } as Anthropic.ToolUseBlock,
      { type: 'tool_use', id: 't2', name: 'a__b_c', input: {}, caller: { type: 'direct' } } as Anthropic.ToolUseBlock,
    ],
  });
  const { client } = fakeClient([toolUse]);
  const caller = new ClaudeCaller({ client, db, monthlyTokenLimit: 10_000 });
  await caller.create(params, { conversationId: 'c1', app: 'workout-memo', page: '/logs' });
  assert.equal(rows.length, 1);
  const { created_at: _at, latency_ms, ...row } = rows[0]!;
  assert.equal(typeof latency_ms, 'number');
  assert.deepEqual(row, {
    conversation_id: 'c1',
    app: 'workout-memo',
    page: '/logs',
    model: 'claude-opus-5-5',
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 5,
    cache_write_tokens: 7,
    stop_reason: 'tool_use',
    tool_calls: 2,
    error_code: null,
  });
  assert.equal(await monthTokens(db, new Date()), 132);
});

test('a failed request leaves a row with an error code and no message text', async () => {
  const { db, rows } = fakeDb();
  const failure = new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'secret prompt text' } }, 'rate limited', new Headers());
  const { client } = fakeClient([failure]);
  const caller = new ClaudeCaller({ client, db, monthlyTokenLimit: 10_000 });
  await assert.rejects(caller.create(params), Anthropic.RateLimitError);
  assert.equal(rows[0]?.error_code, 'http_429');
  assert.equal(rows[0]?.input_tokens, 0);
  assert.doesNotMatch(JSON.stringify(rows), /secret prompt text/);
  assert.equal(errorCode(new Anthropic.APIConnectionError({ message: 'x' })), 'connection');
  assert.equal(errorCode(new Error('x')), 'internal');
});

test('the budget guard answers "monthly limit reached" without calling Claude', async () => {
  const { db } = fakeDb();
  const { client, requests } = fakeClient([message({ usage: { input_tokens: 900, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })]);
  const caller = new ClaudeCaller({ client, db, monthlyTokenLimit: 1000 });
  await caller.create(params);
  await assert.rejects(caller.create(params), (err: unknown) => err instanceof BudgetExceededError && /Monthly limit reached/.test(err.message) && err.used === 1000);
  assert.equal(requests.length, 1, 'the second request never reached Claude');
});

test('the budget counts only this calendar month (UTC)', async () => {
  let now = new Date('2026-10-31T23:00:00Z');
  const { db } = fakeDb(() => now);
  const { client } = fakeClient([message({}), message({})]);
  const caller = new ClaudeCaller({ client, db, monthlyTokenLimit: 132, now: () => now });
  await caller.create(params);
  await assert.rejects(caller.create(params), BudgetExceededError);
  now = new Date('2026-11-01T00:00:01Z');
  await caller.create(params);
  assert.deepEqual(monthStart(new Date('2026-11-18T05:00:00Z')), new Date('2026-11-01T00:00:00Z'));
});

test('inside a tool loop the guard runs before every Claude request', async () => {
  const pair = generateKeyPairSync('ed25519');
  const signer = createSigner(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const app = await startFakeApp('workout-memo', createPublicKey(signer.publicKeyPem()));
  try {
    const hub = new ToolHub({ apps: [{ name: 'workout-memo', url: app.url }], signer, owner: 'user-1', log: () => {} });
    await hub.refresh();
    const { db, rows } = fakeDb();
    const useTool = (id: string) =>
      message({
        stop_reason: 'tool_use',
        usage: { input_tokens: 600, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'tool_use', id, name: 'workout_memo__list_workouts', input: { from: '2026-11-01', to: '2026-11-18' }, caller: { type: 'direct' } } as Anthropic.ToolUseBlock],
      });
    const { client, requests } = fakeClient([useTool('t1'), useTool('t2'), message({})]);
    const caller = new ClaudeCaller({ client, db, monthlyTokenLimit: 1000 });
    await assert.rejects(
      runToolLoop({ caller, hub, request: params, context: { client: 'ai-shell', conversationId: 'c1' }, approve: async () => true }),
      BudgetExceededError,
    );
    assert.equal(requests.length, 2, 'the third request was stopped by the guard');
    assert.equal(app.state.calls.length, 2, 'both tool calls ran');
    assert.equal(rows.length, 2);
    // The tool result went back in one user message after the assistant's full content.
    const second = requests[1]!.messages;
    assert.equal(second.at(-1)?.role, 'user');
    assert.equal((second.at(-1)?.content as Anthropic.ToolResultBlockParam[])[0]?.tool_use_id, 't1');
    assert.equal(requests[0]!.tools?.length, 2);
  } finally {
    await app.close();
  }
});

test('a tool that is not read-only runs only when the owner approves', async () => {
  const pair = generateKeyPairSync('ed25519');
  const signer = createSigner(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const app = await startFakeApp('workout-memo', createPublicKey(signer.publicKeyPem()));
  try {
    const hub = new ToolHub({ apps: [{ name: 'workout-memo', url: app.url }], signer, owner: 'user-1', log: () => {} });
    await hub.refresh();
    const { db } = fakeDb();
    const add = message({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'workout_memo__add_workout', input: { date: '2026-11-18' }, caller: { type: 'direct' } } as Anthropic.ToolUseBlock],
    });
    const { client, requests } = fakeClient([add, message({})]);
    const caller = new ClaudeCaller({ client, db, monthlyTokenLimit: 10_000 });
    const asked: string[] = [];
    const { message: last } = await runToolLoop({
      caller,
      hub,
      request: params,
      context: { client: 'ai-shell' },
      approve: async (tool) => (asked.push(tool.name), false),
    });
    assert.equal(last.stop_reason, 'end_turn');
    assert.deepEqual(asked, ['workout_memo__add_workout']);
    assert.equal(app.state.calls.length, 0);
    const result = (requests[1]!.messages.at(-1)?.content as Anthropic.ToolResultBlockParam[])[0]!;
    assert.equal(result.is_error, true);
  } finally {
    await app.close();
  }
});

test('at the step limit every open tool_use gets an error result, so the conversation can continue', async () => {
  const pair = generateKeyPairSync('ed25519');
  const signer = createSigner(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const app = await startFakeApp('workout-memo', createPublicKey(signer.publicKeyPem()));
  try {
    const hub = new ToolHub({ apps: [{ name: 'workout-memo', url: app.url }], signer, owner: 'user-1', log: () => {} });
    await hub.refresh();
    const { db } = fakeDb();
    const useTool = (id: string) =>
      message({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id, name: 'workout_memo__list_workouts', input: {}, caller: { type: 'direct' } } as Anthropic.ToolUseBlock],
      });
    const { client, requests } = fakeClient([useTool('t1'), useTool('t2'), message({})]);
    const caller = new ClaudeCaller({ client, db, monthlyTokenLimit: 100_000 });
    const { messages } = await runToolLoop({ caller, hub, request: params, context: { client: 'ai-shell' }, approve: async () => true, maxRequests: 2 });
    assert.equal(requests.length, 2);
    assert.equal(app.state.calls.length, 1, 'the tool asked for at the limit does not run');
    const last = messages.at(-1)!;
    assert.equal(last.role, 'user');
    const [result] = last.content as Anthropic.ToolResultBlockParam[];
    assert.equal(result?.tool_use_id, 't2');
    assert.equal(result?.is_error, true);
  } finally {
    await app.close();
  }
});

test('a usage row that cannot be written is logged and the answer is still returned', async () => {
  const db: Db = {
    query: async <R>(text: string) => {
      if (/^\s*insert into ai_usage/i.test(text)) throw new Error('db down');
      return { rows: [{ total: null }] as R[] };
    },
  };
  const lines: string[] = [];
  const { client } = fakeClient([message({})]);
  const caller = new ClaudeCaller({ client, db, monthlyTokenLimit: 1000, log: (line) => lines.push(line) });
  const answer = await caller.create(params);
  assert.equal(answer.stop_reason, 'end_turn');
  assert.match(lines[0] ?? '', /usage row not written/);
});

test('hub tools become Messages API tools without the $schema key', () => {
  const [tool] = claudeTools([
    {
      name: 'workout_memo__list_workouts',
      app: 'workout-memo',
      tool: 'list_workouts',
      description: 'List.',
      inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: {} },
      scope: 'workout-memo:read',
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
  ]);
  assert.deepEqual(tool, { name: 'workout_memo__list_workouts', description: '[workout-memo] List.', input_schema: { type: 'object', properties: {} } });
});

test('the tools of the current app come first and the rest keep their order (#916)', () => {
  const tool = (app: string, name: string) => ({
    name: `${app.replace('-', '_')}__${name}`,
    app,
    tool: name,
    description: 'x',
    inputSchema: { type: 'object' as const, properties: {} },
    scope: `${app}:read`,
    annotations: { readOnlyHint: true, destructiveHint: false },
  });
  const tools = [tool('cert-manager', 'list_certifications'), tool('money-ledger', 'list_entries'), tool('workout-memo', 'add_workout'), tool('workout-memo', 'list_workouts')];
  assert.deepEqual(
    claudeTools(tools, 'workout-memo').map((t) => t.name),
    ['workout_memo__add_workout', 'workout_memo__list_workouts', 'cert_manager__list_certifications', 'money_ledger__list_entries'],
  );
  assert.deepEqual(
    claudeTools(tools).map((t) => t.name),
    tools.map((t) => t.name),
    'without a current app the order is unchanged',
  );
  assert.deepEqual(
    claudeTools(tools, 'unknown-app').map((t) => t.name),
    tools.map((t) => t.name),
    'an app with no tools changes nothing',
  );
});
