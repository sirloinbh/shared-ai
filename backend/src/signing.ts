// Signed internal calls (ADR-0017): shared-ai signs one short-lived EdDSA JWT per call to an app's /internal/tools.
// The app checks it with shared-ai's public key (standard/tools.ts in each app, docs/ai-tools.md in project-standards):
// header alg EdDSA; iss "shared-ai"; aud the app name; sub the owner; client; space-separated scope; iat; exp, at most
// 300 s after iat. The caller's own token (a session cookie or an OAuth token) is never forwarded.
import { createPrivateKey, createPublicKey, type KeyObject, sign } from 'node:crypto';

export const ISSUER = 'shared-ai';
/** Seconds a call token stays valid. Apps reject tokens valid for more than 300 s. */
export const TOKEN_SECONDS = 60;

export type CallClaims = { app: string; owner: string; client: string; scopes: readonly string[] };

/** Reads a PEM that may hold `\n` escapes, as one-line values in SSM and .env do. */
export function pemFromEnv(value: string): string {
  return value.replace(/\\n/g, '\n').trim() + '\n';
}

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

export type Signer = {
  sign: (claims: CallClaims, now?: number) => string;
  /** The Ed25519 public key (SPKI PEM) the apps set as AI_TOOLS_PUBLIC_KEY. */
  publicKeyPem: () => string;
};

export function createSigner(privateKeyPem: string): Signer {
  const key: KeyObject = createPrivateKey(pemFromEnv(privateKeyPem));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('AI_TOOLS_SIGNING_KEY must be an Ed25519 private key');
  return {
    sign({ app, owner, client, scopes }, now = Date.now()) {
      const iat = Math.floor(now / 1000);
      const header = part({ alg: 'EdDSA', typ: 'JWT' });
      const payload = part({ iss: ISSUER, aud: app, sub: owner, client, scope: scopes.join(' '), iat, exp: iat + TOKEN_SECONDS });
      const signature = sign(null, Buffer.from(`${header}.${payload}`), key).toString('base64url');
      return `${header}.${payload}.${signature}`;
    },
    publicKeyPem: () => createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString(),
  };
}
