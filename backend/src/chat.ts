// The AI shell's HTTP API (#612, ADR-0017):
//   POST /api/chat          one conversation turn, answered as a server-sent event stream
//   POST /api/chat/confirm  the owner's answer to a tool call that changes data
// Browser access: the shared session cookie (checked with shared-auth), CORS only for <app>.<root domain> with
// credentials, and the header `X-Requested-With: ai-shell` on every POST (a custom header forces a CORS preflight,
// so a foreign page cannot send it). Only the owner (AI_OWNER_ID) may chat. Events, one JSON object per `data:` line:
//   start {conversationId}  text {delta}  tool_call {id, app, tool, input, readOnly, needsConfirmation}  tool_result {id, ok, summary}
//   limit {message}  error {message}  done {conversationId}
// `start` comes first: the shell needs the id to answer a confirmation (POST /api/chat/confirm) while the stream is
// still open, because `done` is sent only after that answer (#907).
import { randomUUID } from 'node:crypto';

import type Anthropic from '@anthropic-ai/sdk';
import express, { type Request, type Response, Router } from 'express';
import { z } from 'zod';

import { BudgetExceededError, type ClaudeCaller } from './claude.js';
import type { ChatStore } from './chat-store.js';
import type { ToolHub } from './hub.js';
import { runToolLoop } from './loop.js';
import type { SessionCheck, SessionUser } from './session.js';

export type ChatDeps = {
  session: SessionCheck;
  store: ChatStore;
  /** Undefined while no Claude key is set: the route answers 503. */
  caller: ClaudeCaller | undefined;
  hub: ToolHub;
  /** The one user ID that may chat (AI_OWNER_ID). */
  owner: string;
  model: string;
  /** Subdomains of this domain may call from a browser. Unset: none. */
  rootDomain: string | undefined;
  /** How long a change waits for the owner's answer before it counts as refused (default 120 s). */
  confirmMs?: number;
  /** Seconds between keep-alive comments on an open stream (default 15). */
  keepAliveMs?: number;
  newId?: () => string;
};

const MAX_HISTORY_MESSAGES = 80;
const SUMMARY_CHARS = 300;

const BodySchema = z.object({
  conversationId: z.uuid().optional(),
  messages: z.array(z.object({ role: z.literal('user'), content: z.string().trim().min(1).max(8000) })).length(1),
  context: z.object({
    app: z.string().regex(/^[a-z0-9-]{1,64}$/),
    page: z.string().regex(/^\/[\w\-./~%]{0,199}$/),
  }),
});

const ConfirmSchema = z.object({ conversationId: z.uuid(), callId: z.string().min(1).max(200), approve: z.boolean() });

type Pending = { owner: string; resolve: (approved: boolean) => void; timer: NodeJS.Timeout };

/** The origin when it is `https://<label>.<root>` and not the AI service itself, else null. */
export function allowedOrigin(origin: string | undefined, rootDomain: string | undefined): string | null {
  if (!origin || !rootDomain) return null;
  const match = /^https:\/\/([a-z0-9-]+)\.(.+)$/.exec(origin);
  return match && match[2] === rootDomain && match[1] !== 'ai' ? origin : null;
}

function systemPrompt(app: string, page: string): string {
  return [
    "You are the assistant of the owner of a personal app portfolio. You can read and change the owner's data in the apps through your tools.",
    `The owner is in the app "${app}" on the page "${page}". When a request names no app, it means this one.`,
    'The system asks the owner before any tool that changes data runs, so call the tool directly; do not ask for permission in text.',
    'Answer briefly, in the language the owner writes in. Say so plainly when a tool failed or the owner refused a change.',
  ].join('\n');
}

const textOf = (message: Anthropic.Message) =>
  message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

function summaryOf(result: Anthropic.ToolResultBlockParam): string {
  const text = typeof result.content === 'string' ? result.content : '';
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text;
}

export function createChatRouter(deps: ChatDeps): Router {
  const router = Router();
  const pending = new Map<string, Pending>();
  const busy = new Set<string>();
  const confirmMs = deps.confirmMs ?? 120_000;
  const keepAliveMs = deps.keepAliveMs ?? 15_000;
  const newId = deps.newId ?? randomUUID;

  // CORS and the CSRF header guard, for both routes.
  router.use('/chat', (req, res, next) => {
    const origin = req.headers.origin;
    const allowed = allowedOrigin(origin, deps.rootDomain);
    if (origin && !allowed) return void res.status(403).json({ error: 'This origin may not use the AI service' });
    if (allowed) {
      res.set({ 'Access-Control-Allow-Origin': allowed, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' });
      if (req.method === 'OPTIONS') {
        res.set({ 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, x-requested-with', 'Access-Control-Max-Age': '600' });
        return void res.status(204).end();
      }
    }
    if (req.method !== 'POST') return void res.status(405).set('Allow', 'POST, OPTIONS').json({ error: 'Use POST' });
    if (req.get('x-requested-with') !== 'ai-shell') return void res.status(403).json({ error: 'Missing X-Requested-With header' });
    next();
  });
  router.use('/chat', express.json({ limit: '32kb' }));

  /** The signed-in owner, or null after the error answer is sent. */
  async function owner(req: Request, res: Response): Promise<SessionUser | null> {
    const result = await deps.session(req.headers.cookie);
    if (result.status === 'ok' && result.user.id === deps.owner) return result.user;
    if (result.status === 'unavailable') res.status(503).json({ error: 'The sign-in service does not answer' });
    else if (result.status === 'none') res.status(401).json({ error: 'Sign in first' });
    else res.status(403).json({ error: 'This account may not use the AI shell' });
    return null;
  }

  router.post('/chat/confirm', async (req, res) => {
    const user = await owner(req, res);
    if (!user) return;
    const body = ConfirmSchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'Invalid request' });
    const key = `${body.data.conversationId}:${body.data.callId}`;
    const entry = pending.get(key);
    if (!entry || entry.owner !== user.id) return void res.status(404).json({ error: 'No change is waiting for an answer' });
    clearTimeout(entry.timer);
    pending.delete(key);
    entry.resolve(body.data.approve);
    res.status(204).end();
  });

  router.post('/chat', async (req, res) => {
    const user = await owner(req, res);
    if (!user) return;
    const body = BodySchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'Invalid request' });
    if (!deps.caller) return void res.status(503).json({ error: 'The AI service has no Claude key yet' });
    const { messages: input, context } = body.data;

    let conversationId = body.data.conversationId;
    let history: Anthropic.MessageParam[] = [];
    if (conversationId) {
      const loaded = await deps.store.load(conversationId, user.id);
      if (!loaded) return void res.status(404).json({ error: 'Unknown conversation' });
      history = loaded;
    } else {
      conversationId = newId();
      await deps.store.create(conversationId, user.id);
    }
    if (history.length >= MAX_HISTORY_MESSAGES) return void res.status(409).json({ error: 'This conversation is too long: start a new one' });
    if (busy.has(conversationId)) return void res.status(409).json({ error: 'This conversation is still answering' });
    busy.add(conversationId);

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
    let closed = false;
    const send = (event: Record<string, unknown>) => {
      if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: 'start', conversationId });
    const keepAlive = setInterval(() => !closed && res.write(': keep-alive\n\n'), keepAliveMs);
    const mine = new Set<string>();
    res.on('close', () => {
      closed = true;
      // A closed stream cannot show the question, so what waits counts as refused.
      for (const key of mine) {
        const entry = pending.get(key);
        if (entry) {
          clearTimeout(entry.timer);
          pending.delete(key);
          entry.resolve(false);
        }
      }
    });

    try {
      const { messages } = await runToolLoop({
        caller: deps.caller,
        hub: deps.hub,
        request: { model: deps.model, max_tokens: 4096, system: systemPrompt(context.app, context.page), messages: [...history, { role: 'user', content: input[0]!.content }] },
        context: { conversationId, app: context.app, page: context.page, client: 'ai-shell' },
        approve: (_tool, _input, id) => {
          if (closed) return Promise.resolve(false);
          const key = `${conversationId}:${id}`;
          mine.add(key);
          return new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              pending.delete(key);
              resolve(false);
            }, confirmMs);
            pending.set(key, { owner: user.id, resolve, timer });
          });
        },
        hooks: {
          onMessage: (message) => {
            const delta = textOf(message);
            if (delta) send({ type: 'text', delta });
          },
          onToolCall: (use, tool) =>
            send({ type: 'tool_call', id: use.id, app: tool.app, tool: tool.tool, input: use.input, readOnly: tool.annotations.readOnlyHint, needsConfirmation: !tool.annotations.readOnlyHint }),
          onToolResult: (use, result) => send({ type: 'tool_result', id: use.id, ok: result.is_error !== true, summary: summaryOf(result) }),
        },
      });
      await deps.store.save(conversationId, user.id, messages);
      send({ type: 'done', conversationId });
    } catch (err) {
      if (err instanceof BudgetExceededError) send({ type: 'limit', message: 'The monthly AI limit is reached. It resets at the start of next month.' });
      else {
        console.error(`chat: turn failed (${err instanceof Error ? err.name : 'unknown'})`);
        send({ type: 'error', message: 'The assistant could not answer. Try again.' });
      }
    } finally {
      clearInterval(keepAlive);
      busy.delete(conversationId);
      res.end();
    }
  });

  return router;
}
