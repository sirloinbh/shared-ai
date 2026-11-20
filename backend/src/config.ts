import { type AppTarget, toolApps } from './apps.js';

const required = (env: NodeJS.ProcessEnv, key: string): string => {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is not set (see .env.example)`);
  return value;
};

const positiveInt = (env: NodeJS.ProcessEnv, key: string, fallback?: number): number => {
  const raw = env[key]?.trim();
  if (!raw) {
    if (fallback === undefined) throw new Error(`${key} is not set (see .env.example)`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive whole number`);
  return value;
};

export type HubConfig = {
  apps: AppTarget[];
  signingKey: string;
  owner: string;
  refreshMs: number;
};

/** What the tool hub needs: the apps, the signing key, and the owner. The MCP stdio entry needs only this. */
export function loadHubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  return {
    apps: toolApps(env),
    signingKey: required(env, 'AI_TOOLS_SIGNING_KEY'),
    owner: env.AI_OWNER_ID?.trim() || 'owner',
    refreshMs: positiveInt(env, 'AI_TOOLS_REFRESH_SECONDS', 180) * 1000,
  };
}

export type ServerConfig = HubConfig & {
  databaseUrl: string;
  port: number;
  monthlyTokenLimit: number;
  anthropicApiKey: string | undefined;
  model: string;
  /** The shared sign-in service on the shared-auth network (AUTH_INTERNAL_URL). Unset: the AI shell is off. */
  authUrl: string | undefined;
  /** The root domain whose subdomains may call /api/chat from a browser (AI_ROOT_DOMAIN). Unset: no browser origin. */
  rootDomain: string | undefined;
};

/** Reads the service settings from the environment. Every key is listed in .env.example. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    ...loadHubConfig(env),
    databaseUrl: required(env, 'DATABASE_URL'),
    port: positiveInt(env, 'PORT', 3111),
    monthlyTokenLimit: positiveInt(env, 'AI_MONTHLY_TOKEN_LIMIT'),
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
    model: env.CLAUDE_MODEL?.trim() || 'claude-opus-5-5',
    authUrl: env.AUTH_INTERNAL_URL?.trim() || undefined,
    rootDomain: env.AI_ROOT_DOMAIN?.trim().toLowerCase() || undefined,
  };
}
