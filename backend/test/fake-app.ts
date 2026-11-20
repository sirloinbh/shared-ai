// A stand-in for an app's /internal/tools, for tests. The token check is the managed file standard/tools.ts (synced from
// templates/app/backend/src/standard/ in sirloinbh/project-standards, #672), so a token this service signs is checked
// exactly as an app checks it, and a change to the claims or limits fails a test here. The routes answer like
// registerToolRoutes there: the list as `{ app, tools }`, a call as `{ result }`, errors as `{ error }` with 401, 403,
// 404, or 400; a token works once, for the tool it names.
import type { KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { createSeenTokens, LIST_TOOL, MAX_TOKEN_SECONDS, type ToolCaller, verifyCallToken } from './standard/tools.js';

export { MAX_TOKEN_SECONDS, verifyCallToken };

/** An error with the HTTP status the fake app answers with. */
class CallError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const statusOf = (err: unknown) => (err instanceof Error && 'status' in err && typeof err.status === 'number' ? err.status : null);


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
  const seen = createSeenTokens();
  const check = (req: express.Request, tool: string) => {
    const match = /^Bearer (\S+)$/.exec(req.get('authorization') ?? '');
    if (!match?.[1]) throw new CallError(401, 'Call token missing');
    const verified = verifyCallToken(match[1], publicKey, app);
    if (verified.tool !== tool) throw new CallError(401, 'Call token is not for this tool');
    if (!verified.jti || !seen.use(verified.jti, verified.exp)) throw new CallError(401, 'Call token was already used');
    return verified;
  };
  const fail = (res: express.Response, err: unknown) => {
    const status = statusOf(err);
    if (status !== null && err instanceof Error) res.status(status).json({ error: err.message });
    else res.status(500).json({ error: 'Internal error' });
  };
  server.use((_req, res, next) => (state.down ? void res.status(503).json({ error: 'down' }) : next()));
  server.get('/internal/tools', (req, res) => {
    try {
      state.lists.push(callerOf(check(req, LIST_TOOL)));
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
