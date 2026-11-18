import express from 'express';

export type AppOptions = {
  /** Resolves when the database answers. */
  ping: () => Promise<void>;
  /** The apps whose tools the hub holds now. */
  apps: () => string[];
};

/** The HTTP API. The AI shell's /api/chat comes with #612; for now it serves the health check. */
export function createApp({ ping, apps }: AppOptions) {
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

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  return app;
}
