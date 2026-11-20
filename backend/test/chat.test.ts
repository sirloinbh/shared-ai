import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import type Anthropic from '@anthropic-ai/sdk';

import { createApp } from '../src/app.js';
import { ChatStore } from '../src/chat-store.js';
import { allowedOrigin, type ChatDeps } from '../src/chat.js';
import { ClaudeCaller, type MessagesClient } from '../src/claude.js';
import { type Db, MIGRATIONS } from '../src/db.js';
import { ToolHub } from '../src/hub.js';
import { createSessionCheck, type SessionCheck } from '../src/session.js';
import { createSigner } from '../src/signing.js';
import { startFakeApp } from './fake-app.js';

const OWNER = 'user-1';
const ORIGIN = 'https://workout-memo.daysofme.com';
const HEADERS = { 'content-type': 'application/json', 'x-requested-with': 'ai-shell', origin: ORIGIN, cookie: 'sirloinbh.session_token=abc' };
const BODY = { messages: [{ role: 'user', content: 'hi' }], context: { app: 'workout-memo', page: '/workouts' } };

/** The chat_conversations and ai_usage queries over memory. */
function fakeDb(usedTokens = 0) {
  const conversations = new Map<string, { owner: string; messages: unknown }>();
  const usage: unknown[][] = [];
  const db: Db = {
    query: async <R>(text: string, values: unknown[] = []) => {
      if (/insert into chat_conversations/.test(text)) {
        conversations.set(values[0] as string, { owner: values[1] as string, messages: JSON.parse(values[2] as string) });
        return { rows: [] as R[] };
      }
      if (/select messages from chat_conversations/.test(text)) {
        const row = conversations.get(values[0] as string);
        return { rows: (row && row.owner === values[1] ? [{ messages: row.messages }] : []) as R[] };
      }
      if (/update chat_conversations/.test(text)) {
        const row = conversations.get(values[0] as string);
        if (row && row.owner === values[1]) row.messages = JSON.parse(values[2] as string);
        return { rows: [] as R[] };
      }
      if (/insert into ai_usage/.test(text)) {
        usage.push(values);
        return { rows: [] as R[] };
      }
      if (/sum\(input_tokens/.test(text)) return { rows: [{ total: String(usedTokens) }] as R[] };
      throw new Error(`unexpected query: ${text}`);
    },
  };
  return { db, conversations, usage };
}

function claudeMessage(content: Anthropic.ContentBlock[], stop: Anthropic.Message['stop_reason'] = 'end_turn'): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as Anthropic.Message;
}
const text = (t: string) => ({ type: 'text', text: t, citations: null }) as Anthropic.ContentBlock;
const toolUse = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input, caller: { type: 'direct' } }) as Anthropic.ContentBlock;

type Setup = { base: string; app: Awaited<ReturnType<typeof startFakeApp>>; requests: Anthropic.MessageCreateParamsNonStreaming[]; db: ReturnType<typeof fakeDb>; close: () => Promise<void> };

async function setup(options: { answers?: Anthropic.Message[]; session?: SessionCheck; usedTokens?: number; noClaude?: boolean; confirmMs?: number } = {}): Promise<Setup> {
  const pair = generateKeyPairSync('ed25519');
  const signer = createSigner(pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  const app = await startFakeApp('workout-memo', createPublicKey(signer.publicKeyPem()));
  const hub = new ToolHub({ apps: [{ name: 'workout-memo', url: app.url }], signer, owner: OWNER, log: () => {} });
  await hub.refresh();
  const db = fakeDb(options.usedTokens);
  const answers = [...(options.answers ?? [])];
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (params) => {
        requests.push(structuredClone(params));
        const next = answers.shift();
        if (!next) throw new Error('no scripted answer left');
        return next;
      },
    },
  };
  const deps: ChatDeps = {
    session: options.session ?? (async () => ({ status: 'ok', user: { id: OWNER, email: null } })),
    store: new ChatStore(db.db),
    caller: options.noClaude ? undefined : new ClaudeCaller({ client, db: db.db, monthlyTokenLimit: 1000, log: () => {} }),
    hub,
    owner: OWNER,
    model: 'claude-opus-5-5',
    rootDomain: 'daysofme.com',
    confirmMs: options.confirmMs,
    keepAliveMs: 60_000,
    newId: () => '11111111-1111-4111-8111-111111111111',
  };
  const server = createApp({ ping: async () => {}, apps: () => hub.apps(), chat: deps }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    app,
    requests,
    db,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await app.close();
    },
  };
}

const post = (s: Setup, path: string, body: unknown, headers: Record<string, string> = HEADERS) =>
  fetch(`${s.base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

const parse = (raw: string) =>
  raw
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)) as { type: string; [key: string]: unknown });

/** Reads the stream until `until` says so (or it ends); returns the events seen. */
async function readUntil(res: Response, until: (event: { type: string }) => boolean) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    if (parse(raw).some(until)) break;
  }
  return { events: parse(raw), reader, raw, decoder };
}

test('the chat tables are created by migration 002 and hold no usage columns', () => {
  const sql = MIGRATIONS.find((m) => m.id === '002_chat')?.sql ?? '';
  assert.match(sql, /create table chat_conversations/);
  assert.match(sql, /owner text not null/);
});

test('only https subdomains of the root domain, other than ai, are allowed origins', () => {
  assert.equal(allowedOrigin(ORIGIN, 'daysofme.com'), ORIGIN);
  assert.equal(allowedOrigin('https://ai.daysofme.com', 'daysofme.com'), null);
  assert.equal(allowedOrigin('http://workout-memo.daysofme.com', 'daysofme.com'), null);
  assert.equal(allowedOrigin('https://workout-memo.daysofme.com.evil.test', 'daysofme.com'), null);
  assert.equal(allowedOrigin('https://evil.test', 'daysofme.com'), null);
  assert.equal(allowedOrigin(ORIGIN, undefined), null);
});

test('a preflight from an app subdomain is allowed with credentials; a foreign origin is refused', async () => {
  const s = await setup();
  try {
    const ok = await fetch(`${s.base}/api/chat`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
    assert.match(ok.headers.get('access-control-allow-headers') ?? '', /x-requested-with/);
    const bad = await post(s, '/api/chat', BODY, { ...HEADERS, origin: 'https://evil.test' });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  } finally {
    await s.close();
  }
});

test('a POST needs the guard header, a session, and the owner account', async () => {
  const noHeader = await setup();
  try {
    const { 'x-requested-with': _drop, ...without } = HEADERS;
    assert.equal((await post(noHeader, '/api/chat', BODY, without)).status, 403);
    assert.equal((await fetch(`${noHeader.base}/api/chat`)).status, 405);
  } finally {
    await noHeader.close();
  }
  for (const [session, status] of [
    [async () => ({ status: 'none' as const }), 401],
    [async () => ({ status: 'unavailable' as const }), 503],
    [async () => ({ status: 'ok' as const, user: { id: 'someone-else', email: null } }), 403],
  ] as const) {
    const s = await setup({ session });
    try {
      assert.equal((await post(s, '/api/chat', BODY)).status, status);
      assert.equal((await post(s, '/api/chat/confirm', { conversationId: '11111111-1111-4111-8111-111111111111', callId: 't', approve: true })).status, status);
      assert.equal(s.requests.length, 0);
    } finally {
      await s.close();
    }
  }
});

test('a bad body, no Claude key, and an unknown conversation are refused before any stream', async () => {
  const s = await setup();
  try {
    assert.equal((await post(s, '/api/chat', { ...BODY, messages: [] })).status, 400);
    assert.equal((await post(s, '/api/chat', { ...BODY, context: { app: 'a b', page: '/' } })).status, 400);
    assert.equal((await post(s, '/api/chat', { ...BODY, messages: [{ role: 'assistant', content: 'x' }] })).status, 400);
    assert.equal((await post(s, '/api/chat', { ...BODY, conversationId: '22222222-2222-4222-8222-222222222222' })).status, 404);
    assert.equal(s.requests.length, 0);
  } finally {
    await s.close();
  }
  const none = await setup({ noClaude: true });
  try {
    assert.equal((await post(none, '/api/chat', BODY)).status, 503);
  } finally {
    await none.close();
  }
});

test('a read tool streams tool_call, tool_result, text and done, and the history is saved', async () => {
  const s = await setup({
    answers: [claudeMessage([text('Let me look.'), toolUse('t1', 'workout_memo__list_workouts', { from: '2026-11-01', to: '2026-11-18' })], 'tool_use'), claudeMessage([text('You did 1 workout.')])],
  });
  try {
    const res = await post(s, '/api/chat', BODY);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    const events = parse(await res.text());
    assert.deepEqual(
      events.map((e) => e.type),
      ['start', 'text', 'tool_call', 'tool_result', 'text', 'done'],
    );
    assert.deepEqual(events[0], { type: 'start', conversationId: '11111111-1111-4111-8111-111111111111' }, 'the id comes first, so Allow can be answered before done');
    assert.deepEqual(events[2], { type: 'tool_call', id: 't1', app: 'workout-memo', tool: 'list_workouts', input: { from: '2026-11-01', to: '2026-11-18' }, readOnly: true, needsConfirmation: false });
    assert.equal(events[3]!.ok, true);
    assert.equal(events[5]!.conversationId, '11111111-1111-4111-8111-111111111111');
    assert.equal(s.app.state.calls[0]?.caller.client, 'ai-shell');
    assert.match(String(s.requests[0]!.system), /"workout-memo" on the page "\/workouts"/);
    assert.match(String(s.requests[0]!.system), /use the tools of "workout-memo" and do not read or change another app's data/, 'the prompt keeps the request in the current app (#916)');
    const saved = s.db.conversations.get('11111111-1111-4111-8111-111111111111')!.messages as unknown[];
    assert.equal(saved.length, 4, 'user, assistant, tool result, assistant');
    assert.equal(s.db.usage.length, 2, 'one ai_usage row per Claude request');
    assert.equal(s.db.usage[0]![1], 'workout-memo');
  } finally {
    await s.close();
  }
});

test('a tool that changes data waits for Allow; the stream continues after the confirm call', async () => {
  const s = await setup({ answers: [claudeMessage([toolUse('t1', 'workout_memo__add_workout', { date: '2026-11-18' })], 'tool_use'), claudeMessage([text('Added.')])] });
  try {
    const res = await post(s, '/api/chat', BODY);
    const first = await readUntil(res, (e) => e.type === 'tool_call');
    assert.equal(first.events[0]?.type, 'start', 'the id arrives while the stream still waits for Allow');
    const call = first.events.find((e) => e.type === 'tool_call')!;
    assert.equal(call.needsConfirmation, true);
    assert.equal(call.readOnly, false);
    assert.equal(s.app.state.calls.length, 0, 'nothing ran before the answer');
    const confirm = await post(s, '/api/chat/confirm', { conversationId: '11111111-1111-4111-8111-111111111111', callId: 't1', approve: true });
    assert.equal(confirm.status, 204);
    let raw = first.raw;
    for (;;) {
      const { done, value } = await first.reader.read();
      if (done) break;
      raw += first.decoder.decode(value, { stream: true });
    }
    const events = parse(raw);
    assert.deepEqual(
      events.map((e) => e.type),
      ['start', 'tool_call', 'tool_result', 'text', 'done'],
    );
    assert.equal(events[2]!.ok, true);
    assert.equal(s.app.state.calls.length, 1);
    assert.equal((await post(s, '/api/chat/confirm', { conversationId: '11111111-1111-4111-8111-111111111111', callId: 't1', approve: true })).status, 404, 'an answer counts once');
  } finally {
    await s.close();
  }
});

test('Refuse and a missing answer both leave the data alone', async () => {
  const refused = await setup({ answers: [claudeMessage([toolUse('t1', 'workout_memo__add_workout', { date: '2026-11-18' })], 'tool_use'), claudeMessage([text('Okay, not added.')])] });
  try {
    const res = await post(refused, '/api/chat', BODY);
    const first = await readUntil(res, (e) => e.type === 'tool_call');
    await post(refused, '/api/chat/confirm', { conversationId: '11111111-1111-4111-8111-111111111111', callId: 't1', approve: false });
    let raw = first.raw;
    for (;;) {
      const { done, value } = await first.reader.read();
      if (done) break;
      raw += first.decoder.decode(value, { stream: true });
    }
    const result = parse(raw).find((e) => e.type === 'tool_result')!;
    assert.equal(result.ok, false);
    assert.equal(refused.app.state.calls.length, 0);
  } finally {
    await refused.close();
  }
  const silent = await setup({ confirmMs: 50, answers: [claudeMessage([toolUse('t1', 'workout_memo__add_workout', { date: '2026-11-18' })], 'tool_use'), claudeMessage([text('Not added.')])] });
  try {
    const events = parse(await (await post(silent, '/api/chat', BODY)).text());
    assert.equal(events.find((e) => e.type === 'tool_result')!.ok, false);
    assert.equal(silent.app.state.calls.length, 0);
  } finally {
    await silent.close();
  }
});

test('a reached monthly limit is sent as a limit event and no Claude request is made', async () => {
  const s = await setup({ usedTokens: 1000 });
  try {
    const events = parse(await (await post(s, '/api/chat', BODY)).text());
    assert.deepEqual(
      events.map((e) => e.type),
      ['start', 'limit'],
    );
    assert.match(String(events.find((e) => e.type === 'limit')!.message), /monthly/i);
    assert.equal(s.requests.length, 0);
  } finally {
    await s.close();
  }
});

test('a conversation is stored for its owner and loads for no one else', async () => {
  const check: SessionCheck = createSessionCheck({
    authUrl: 'http://auth.test',
    fetch: (async () => new Response(JSON.stringify({ user: { id: OWNER, email: 'o@example.com' } }))) as typeof fetch,
  });
  const s = await setup({ session: check, answers: [claudeMessage([text('Hello.')])] });
  try {
    const events = parse(await (await post(s, '/api/chat', BODY)).text());
    assert.equal(events.at(-1)!.type, 'done');
    // The store only loads a conversation for its owner.
    assert.equal(await new ChatStore(s.db.db).load('11111111-1111-4111-8111-111111111111', 'someone-else'), null);
  } finally {
    await s.close();
  }
});

test('the session check keeps only the shared cookies, caches a good answer, and fails closed', async () => {
  let calls = 0;
  let sentCookie = '';
  let now = 0;
  const check = createSessionCheck({
    authUrl: 'http://auth.test/',
    now: () => now,
    fetch: (async (_url: string, init: RequestInit) => {
      calls++;
      sentCookie = (init.headers as Record<string, string>).cookie ?? '';
      return new Response(JSON.stringify({ user: { id: OWNER, email: 'o@example.com' } }));
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(await check('other=1'), { status: 'none' });
  assert.equal(calls, 0);
  const cookie = 'tracker=x; __Secure-sirloinbh.session_token=abc; sirloinbh.session_data=def';
  assert.deepEqual(await check(cookie), { status: 'ok', user: { id: OWNER, email: 'o@example.com' } });
  assert.equal(sentCookie, '__Secure-sirloinbh.session_token=abc; sirloinbh.session_data=def');
  await check(cookie);
  assert.equal(calls, 1, 'cached');
  now = 31_000;
  await check(cookie);
  assert.equal(calls, 2, 'the cache expired');

  const down = createSessionCheck({ authUrl: 'http://auth.test', fetch: (async () => new Response('x', { status: 500 })) as typeof fetch });
  assert.deepEqual(await down(cookie), { status: 'unavailable' });
  const signedOut = createSessionCheck({ authUrl: 'http://auth.test', fetch: (async () => new Response('null')) as typeof fetch });
  assert.deepEqual(await signedOut(cookie), { status: 'none' });
});
