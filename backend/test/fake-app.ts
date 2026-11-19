// A stand-in for an app's /internal/tools, for tests. verifyCallToken below is copied unchanged from the managed file
// templates/app/backend/src/standard/tools.ts in sirloinbh/project-standards (commit 8090223), so a token this service
// signs is checked exactly as an app checks it. The routes answer like registerToolRoutes there: the list as
// `{ app, tools }`, a call as `{ result }`, errors as `{ error }` with 401, 403, 404, or 400. Update the copy when that
// file changes.
import { type KeyObject, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import express from 'express';

export type ToolCaller = { owner: string; client: string; scopes: readonly string[]; jti: string | null; tool: string | null; exp: number };

// --- copied from templates/app/backend/src/standard/tools.ts (8090223) ---
export const MAX_TOKEN_SECONDS = 120;
const CLOCK_SKEW_SECONDS = 30;

class CallError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function base64url(part: string) {
  return Buffer.from(part, 'base64url');
}

/** Checks a compact EdDSA JWT from shared-ai for this app and returns the caller, or throws a 401 CallError. */
export function verifyCallToken(token: string, key: KeyObject, app: string, now = Date.now()): ToolCaller {
  const parts = token.split('.');
  if (parts.length !== 3) throw new CallError(401, 'Invalid call token');
  const [header, payload, signature] = parts as [string, string, string];
  let head: { alg?: unknown };
  let claims: Record<string, unknown>;
  try {
    head = JSON.parse(base64url(header).toString('utf8')) as { alg?: unknown };
    claims = JSON.parse(base64url(payload).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new CallError(401, 'Invalid call token');
  }
  if (typeof head !== 'object' || head === null || typeof claims !== 'object' || claims === null) {
    throw new CallError(401, 'Invalid call token');
  }
  if (head.alg !== 'EdDSA') throw new CallError(401, 'Invalid call token');
  let valid = false;
  try {
    valid = verify(null, Buffer.from(`${header}.${payload}`), key, base64url(signature));
  } catch {
    // A malformed signature is a bad token, not a server error.
  }
  if (!valid) throw new CallError(401, 'Invalid call token');
  const seconds = Math.floor(now / 1000);
  const { iss, aud, sub, client, scope, iat, exp, jti, tool } = claims;
  if (iss !== 'shared-ai' || aud !== app) throw new CallError(401, 'Call token is not for this app');
  if (typeof iat !== 'number' || typeof exp !== 'number' || iat > seconds + CLOCK_SKEW_SECONDS) {
    throw new CallError(401, 'Invalid call token');
  }
  if (exp <= seconds - CLOCK_SKEW_SECONDS || exp - iat > MAX_TOKEN_SECONDS) {
    throw new CallError(401, 'Call token expired');
  }
  if (typeof sub !== 'string' || !sub || typeof client !== 'string' || !client || typeof scope !== 'string') {
    throw new CallError(401, 'Invalid call token');
  }
  if ((jti !== undefined && (typeof jti !== 'string' || !jti)) || (tool !== undefined && (typeof tool !== 'string' || !tool))) {
    throw new CallError(401, 'Invalid call token');
  }
  return { owner: sub, client, scopes: scope.split(' ').filter(Boolean), jti: jti ?? null, tool: tool ?? null, exp };
}
// --- end of copy ---

/** The workout-memo pilot tools as its /internal/tools lists them (project-standards #559). */
export const WORKOUT_TOOLS = [
  {
    name: 'list_workouts',
    description: 'List the strength workout journals between two dates (YYYY-MM-DD, at most 366 days), newest first, with their sets.',
    inputSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    scope: 'workout-memo:read',
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'add_workout',
    description: 'Add a strength workout journal.',
    inputSchema: { type: 'object', properties: { date: { type: 'string' }, title: { type: 'string' } }, required: ['date'] },
    scope: 'workout-memo:write',
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

/** What the tests compare: who called, without the per-token claims. */
const callerOf = ({ owner, client, scopes }: ToolCaller) => ({ owner, client, scopes });

export type FakeCall = { tool: string; caller: ReturnType<typeof callerOf>; input: unknown };

/** Serves a fake app on a free port. `tools` and `down` can change while it runs. */
export async function startFakeApp(app: string, publicKey: KeyObject, tools: unknown[] = WORKOUT_TOOLS) {
  const state = { tools, down: false, calls: [] as FakeCall[], lists: [] as ReturnType<typeof callerOf>[] };
  const server = express();
  server.use(express.json());
  const seen = new Set<string>();
  const check = (req: express.Request, tool: string) => {
    const match = /^Bearer (\S+)$/.exec(req.get('authorization') ?? '');
    if (!match?.[1]) throw new CallError(401, 'Call token missing');
    const verified = verifyCallToken(match[1], publicKey, app);
    if (verified.tool !== tool) throw new CallError(401, 'Call token is not for this tool');
    if (!verified.jti || seen.has(verified.jti)) throw new CallError(401, 'Call token was already used');
    seen.add(verified.jti);
    return verified;
  };
  const fail = (res: express.Response, err: unknown) => {
    if (err instanceof CallError) res.status(err.status).json({ error: err.message });
    else res.status(500).json({ error: 'Internal error' });
  };
  server.use((_req, res, next) => (state.down ? void res.status(503).json({ error: 'down' }) : next()));
  server.get('/internal/tools', (req, res) => {
    try {
      state.lists.push(callerOf(check(req, '@list')));
      res.json({ app, tools: state.tools });
    } catch (err) {
      fail(res, err);
    }
  });
  server.post('/internal/tools/:name', (req, res) => {
    try {
      const caller = check(req, String(req.params.name));
      const tool = (state.tools as { name: string; scope: string }[]).find((t) => t.name === req.params.name);
      if (!tool) throw new CallError(404, 'Tool not found');
      if (!caller.scopes.includes(tool.scope)) throw new CallError(403, `Scope ${tool.scope} is required`);
      state.calls.push({ tool: tool.name, caller: callerOf(caller), input: req.body });
      res.json({ result: { tool: tool.name, echo: req.body } });
    } catch (err) {
      fail(res, err);
    }
  });
  const listener = server.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  const url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  return { url, state, close: () => new Promise<void>((resolve) => listener.close(() => resolve())) };
}
