import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';

import { toolApps } from '../src/apps.js';
import { hubToolName, parseToolList, ToolCallError, ToolHub } from '../src/hub.js';
import { createSigner, pemFromEnv, TOKEN_SECONDS } from '../src/signing.js';
import { MAX_TOKEN_SECONDS, startFakeApp, verifyCallToken, WORKOUT_TOOLS } from './fake-app.js';

const pair = generateKeyPairSync('ed25519');
const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const signer = createSigner(privatePem);
const publicKey = createPublicKey(signer.publicKeyPem());
const quiet = () => {};

test('a signed call token passes the app check with the owner, client, and scopes', () => {
  const token = signer.sign({ app: 'workout-memo', owner: 'user-1', client: 'stdio', scopes: ['workout-memo:read', 'workout-memo:write'] });
  assert.deepEqual(verifyCallToken(token, publicKey, 'workout-memo'), { owner: 'user-1', client: 'stdio', scopes: ['workout-memo:read', 'workout-memo:write'] });
  const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { iat: number; exp: number; iss: string };
  assert.equal(claims.iss, 'shared-ai');
  assert.equal(claims.exp - claims.iat, TOKEN_SECONDS);
  assert.ok(TOKEN_SECONDS <= MAX_TOKEN_SECONDS, 'apps reject longer tokens');
});

test('a call token is only for its app, and expires', () => {
  const token = signer.sign({ app: 'workout-memo', owner: 'user-1', client: 'stdio', scopes: [] });
  assert.throws(() => verifyCallToken(token, publicKey, 'study-log'), /not for this app/);
  const old = signer.sign({ app: 'workout-memo', owner: 'user-1', client: 'stdio', scopes: [] }, Date.now() - 10 * 60_000);
  assert.throws(() => verifyCallToken(old, publicKey, 'workout-memo'), /expired/);
  const other = createPublicKey(generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
  assert.throws(() => verifyCallToken(token, other, 'workout-memo'), /Invalid call token/);
});

test('the signing key may come as one line with \\n escapes, and must be Ed25519', () => {
  const oneLine = privatePem.trim().replace(/\n/g, '\\n');
  assert.equal(pemFromEnv(oneLine), privatePem);
  assert.equal(createSigner(oneLine).publicKeyPem(), signer.publicKeyPem());
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.throws(() => createSigner(rsa), /Ed25519/);
});

test('hub tool names carry the app prefix in snake_case', () => {
  assert.equal(hubToolName('workout-memo', 'list_workouts'), 'workout_memo__list_workouts');
  assert.equal(hubToolName('dev-career-portfolio', 'list_projects'), 'dev_career_portfolio__list_projects');
});

test('the default app list is the registry apps at <app>-api:<api port>, and AI_TOOL_APPS overrides it', () => {
  const apps = toolApps({});
  assert.equal(apps.length, 8);
  assert.deepEqual(apps[0], { name: 'workout-memo', url: 'http://workout-memo-api:3101' });
  assert.deepEqual(toolApps({ AI_TOOL_APPS: 'workout-memo=http://127.0.0.1:9/' }), [{ name: 'workout-memo', url: 'http://127.0.0.1:9' }]);
  assert.throws(() => toolApps({ AI_TOOL_APPS: 'workout-memo' }), /bad entry/);
});

test('a tool list with a wrong app, name, schema, or scope is refused', () => {
  assert.equal(parseToolList('workout-memo', { app: 'workout-memo', tools: WORKOUT_TOOLS }).length, 2);
  assert.throws(() => parseToolList('workout-memo', { app: 'study-log', tools: [] }), /for app/);
  const tool = WORKOUT_TOOLS[0]!;
  assert.throws(() => parseToolList('workout-memo', { app: 'workout-memo', tools: [{ ...tool, name: 'List' }] }), /invalid name/);
  assert.throws(() => parseToolList('workout-memo', { app: 'workout-memo', tools: [{ ...tool, inputSchema: [] }] }), /inputSchema/);
  assert.throws(() => parseToolList('workout-memo', { app: 'workout-memo', tools: [{ ...tool, scope: 'study-log:read' }] }), /scope/);
});

test('the hub lists the tools of apps that answer and leaves out the others', async () => {
  const app = await startFakeApp('workout-memo', publicKey);
  try {
    const hub = new ToolHub({ apps: [{ name: 'workout-memo', url: app.url }, { name: 'study-log', url: 'http://127.0.0.1:9' }], signer, owner: 'user-1', log: quiet });
    await hub.refresh();
    assert.deepEqual(hub.apps(), ['workout-memo']);
    assert.deepEqual(hub.list().map((t) => t.name), ['workout_memo__add_workout', 'workout_memo__list_workouts']);
    const list = hub.get('workout_memo__list_workouts')!;
    assert.equal(list.app, 'workout-memo');
    assert.equal(list.tool, 'list_workouts');
    assert.deepEqual(list.annotations, { readOnlyHint: true, destructiveHint: false });
    // Listing needs a valid token but grants no scope.
    assert.deepEqual(app.state.lists[0], { owner: 'user-1', client: 'shared-ai', scopes: [] });
  } finally {
    await app.close();
  }
});

test('an app that stops answering drops out, comes back when it answers, and each change is announced', async () => {
  const app = await startFakeApp('workout-memo', publicKey);
  try {
    const lines: string[] = [];
    const hub = new ToolHub({ apps: [{ name: 'workout-memo', url: app.url }], signer, owner: 'user-1', log: (l) => lines.push(l) });
    let changes = 0;
    hub.onChange(() => changes++);
    await hub.refresh();
    await hub.refresh();
    assert.equal(changes, 1, 'an unchanged list is not announced');
    app.state.down = true;
    await hub.refresh();
    assert.deepEqual(hub.list(), []);
    assert.match(lines.join('\n'), /workout-memo dropped: HTTP 503/);
    app.state.down = false;
    app.state.tools = [WORKOUT_TOOLS[0]];
    await hub.refresh();
    assert.deepEqual(hub.list().map((t) => t.name), ['workout_memo__list_workouts']);
    assert.equal(changes, 3);
  } finally {
    await app.close();
  }
});

test('a call goes to the app with a token for that app, the client, and only the scope the tool needs', async () => {
  const app = await startFakeApp('workout-memo', publicKey);
  try {
    const hub = new ToolHub({ apps: [{ name: 'workout-memo', url: app.url }], signer, owner: 'user-1', log: quiet });
    await hub.refresh();
    const result = await hub.call('workout_memo__add_workout', { date: '2026-11-18' }, { client: 'stdio' });
    assert.deepEqual(result, { tool: 'add_workout', echo: { date: '2026-11-18' } });
    assert.deepEqual(app.state.calls[0], {
      tool: 'add_workout',
      caller: { owner: 'user-1', client: 'stdio', scopes: ['workout-memo:write'] },
      input: { date: '2026-11-18' },
    });
    await hub.call('workout_memo__list_workouts', { from: '2026-11-01', to: '2026-11-18' }, { client: 'stdio' });
    assert.deepEqual(app.state.calls[1]?.caller.scopes, ['workout-memo:read'], 'a read call carries no write scope');
  } finally {
    await app.close();
  }
});

test('the app decides the scope; its refusal and unknown tools come back as ToolCallError', async () => {
  const app = await startFakeApp('workout-memo', publicKey);
  try {
    const hub = new ToolHub({ apps: [{ name: 'workout-memo', url: app.url }], signer, owner: 'user-1', log: quiet });
    await hub.refresh();
    // A scope the caller does not hold is not granted; the app refuses the call.
    await assert.rejects(
      hub.call('workout_memo__add_workout', {}, { client: 'ai-shell', scopes: ['workout-memo:read', 'study-log:write'] }),
      (err: unknown) => err instanceof ToolCallError && err.status === 403 && /workout-memo:write/.test(err.message),
    );
    await assert.rejects(hub.call('workout_memo__nothing', {}, { client: 'stdio' }), (err: unknown) => err instanceof ToolCallError && err.status === 404);
    app.state.down = true;
    await assert.rejects(hub.call('workout_memo__list_workouts', {}, { client: 'stdio' }), (err: unknown) => err instanceof ToolCallError && err.status === 503);
  } finally {
    await app.close();
  }
});

test('two refreshes started together join one run: one list request per app', async () => {
  const one = await startFakeApp('workout-memo', publicKey);
  const two = await startFakeApp('study-log', publicKey, [{ ...WORKOUT_TOOLS[0]!, scope: 'study-log:read' }]);
  try {
    const hub = new ToolHub({ apps: [{ name: 'workout-memo', url: one.url }, { name: 'study-log', url: two.url }], signer, owner: 'user-1', log: quiet });
    const first = hub.refresh();
    const second = hub.refresh();
    assert.equal(first, second, 'the second call joins the running refresh');
    await Promise.all([first, second]);
    assert.equal(one.state.lists.length, 1);
    assert.equal(two.state.lists.length, 1);
    // Once the run is over, the next refresh starts a new one.
    await hub.refresh();
    assert.equal(one.state.lists.length, 2);
  } finally {
    await one.close();
    await two.close();
  }
});
