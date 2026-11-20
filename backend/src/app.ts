import express from 'express';

import { type ChatDeps, createChatRouter } from './chat.js';

export type AppOptions = {
  /** Resolves when the database answers. */
  ping: () => Promise<void>;
  /** The apps whose tools the hub holds now. */
  apps: () => string[];
  /** The AI shell's routes (#612). Left out, /api/chat answers 404. */
  chat?: ChatDeps;
};

/** The HTTP API: the health check and, when `chat` is given, the AI shell's /api/chat. */
export function createApp({ ping, apps, chat }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "frame-ancestors 'none'", 'Cache-Control': 'no-store' });
    next();
  });

  app.get('/api/health', async (_req, res) => {
    try {
      await ping();
      res.json({ status: 'ok', apps: apps() });
    } catch {
      res.status(503).json({ status: 'db_unavailable' });
    }
  });

  if (chat) app.use('/api', createChatRouter(chat));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  return app;
}
