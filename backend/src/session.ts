// The shared sign-in check for the AI shell (ADR-0015, #612): the browser sends the session cookie that shared-auth set on
// the parent domain; this service asks shared-auth who it is over the private `shared-auth` Docker network, like
// @sirloinbh/auth-client does in the apps. It is written out here so the service needs no private package.

export type SessionUser = { id: string; email: string | null };

export type SessionResult = { status: 'ok'; user: SessionUser } | { status: 'none' } | { status: 'unavailable' };

/** Cookies the auth service sets on the parent domain (Better Auth, cookie prefix "sirloinbh"). */
const SESSION_COOKIES = ['sirloinbh.session_token', 'sirloinbh.session_data'];

/** Keeps only the shared session cookies from a Cookie header ("__Secure-" names included). */
export function sessionCookies(header: string | undefined): string {
  return (header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => SESSION_COOKIES.includes(part.slice(0, part.indexOf('=')).replace(/^__Secure-/, '')))
    .join('; ');
}

const tokenOf = (cookies: string) => /(?:^|; )(?:__Secure-)?sirloinbh\.session_token=([^;]+)/.exec(cookies)?.[1] ?? null;

export type SessionCheckOptions = {
  /** The auth service on the shared-auth network, for example http://shared-auth-api:3110 */
  authUrl: string;
  fetch?: typeof fetch;
  /** How long a successful check is reused (default 30 s). */
  cacheMs?: number;
  timeoutMs?: number;
  now?: () => number;
};

export type SessionCheck = (cookieHeader: string | undefined) => Promise<SessionResult>;

export function createSessionCheck(options: SessionCheckOptions): SessionCheck {
  const { authUrl, fetch: doFetch = globalThis.fetch, cacheMs = 30_000, timeoutMs = 3_000, now = Date.now } = options;
  const sessionUrl = `${authUrl.replace(/\/+$/, '')}/api/auth/get-session`;
  const cache = new Map<string, { user: SessionUser; until: number }>();
  return async (cookieHeader) => {
    const cookies = sessionCookies(cookieHeader);
    const token = tokenOf(cookies);
    if (!token) return { status: 'none' };
    const hit = cache.get(token);
    if (hit && hit.until > now()) return { status: 'ok', user: hit.user };
    cache.delete(token);
    let body: { user?: { id?: unknown; email?: unknown } } | null;
    try {
      const response = await doFetch(sessionUrl, { headers: { cookie: cookies }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return { status: 'unavailable' };
      body = (await response.json()) as typeof body;
    } catch {
      return { status: 'unavailable' };
    }
    const id = body?.user?.id;
    if (typeof id !== 'string' || !id) return { status: 'none' };
    const user = { id, email: typeof body?.user?.email === 'string' ? body.user.email : null };
    if (cache.size >= 100) cache.delete(cache.keys().next().value as string);
    cache.set(token, { user, until: now() + cacheMs });
    return { status: 'ok', user };
  };
}
