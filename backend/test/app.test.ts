import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

async function serve(app: ReturnType<typeof createApp>, run: (base: string) => Promise<void>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test('health answers 200 with the apps that answer, or 503 when the database is down', async () => {
  await serve(createApp({ ping: async () => {}, apps: () => ['workout-memo'] }), async (base) => {
    const r = await fetch(`${base}/api/health`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { status: 'ok', apps: ['workout-memo'] });
    assert.equal((await fetch(`${base}/internal/tools`)).status, 404);
  });
  await serve(createApp({ ping: () => Promise.reject(new Error('down')), apps: () => [] }), async (base) => {
    assert.equal((await fetch(`${base}/api/health`)).status, 503);
  });
});

test('the config needs the signing key, the database, and a positive monthly token limit', () => {
  const env = { AI_TOOLS_SIGNING_KEY: 'k', DATABASE_URL: 'postgres://x', AI_MONTHLY_TOKEN_LIMIT: '5000000' };
  const config = loadConfig(env);
  assert.equal(config.monthlyTokenLimit, 5_000_000);
  assert.equal(config.port, 3111);
  assert.equal(config.refreshMs, 180_000);
  assert.equal(config.owner, 'owner');
  assert.equal(config.anthropicApiKey, undefined);
  assert.throws(() => loadConfig({ ...env, AI_MONTHLY_TOKEN_LIMIT: '' }), /AI_MONTHLY_TOKEN_LIMIT is not set/);
  assert.throws(() => loadConfig({ ...env, AI_MONTHLY_TOKEN_LIMIT: '-1' }), /positive whole number/);
  assert.throws(() => loadConfig({ ...env, AI_TOOLS_SIGNING_KEY: '' }), /AI_TOOLS_SIGNING_KEY/);
});
