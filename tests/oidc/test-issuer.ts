import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

/**
 * A small OpenID Connect issuer for tests and local development only: discovery, signing keys, an authorization
 * endpoint that signs in a named test person without a password, a token endpoint with PKCE, and key rotation on
 * demand. It is never part of a production image and refuses to start when NODE_ENV=production.
 */
export interface TestPerson {
  subject: string;
  name: string;
}
export interface TestClient {
  clientId: string;
  redirectUris: string[];
}
export interface TestIssuerOptions {
  host?: string;
  port?: number;
  people?: TestPerson[];
  clients?: TestClient[];
  /** Lifetime of an issued ID token. */
  tokenSeconds?: number;
}
export interface MintOptions {
  subject: string;
  audience?: string;
  issuer?: string;
  expiresInSeconds?: number;
  /** Seconds since the epoch; defaults to now. */
  authTime?: number | null;
  notBeforeSeconds?: number;
  nonce?: string;
  /** A key the issuer does not publish, to sign a token no published key verifies. */
  unpublishedKey?: boolean;
}
export interface TestIssuer {
  url: string;
  server: Server;
  /** Signs a token directly, with any claim a test needs to be wrong. */
  mint(options: MintOptions): Promise<string>;
  /** Replaces the signing key; the old key is no longer published. */
  rotate(): Promise<void>;
  /** How many times each path was requested. */
  requests: Map<string, number>;
  close(): Promise<void>;
}

interface SigningKey {
  kid: string;
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  publicJwk: JWK;
}
interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce?: string;
  subject: string;
  authTime: number;
  expiresAt: number;
}
interface Refresh {
  clientId: string;
  subject: string;
  authTime: number;
}

const ALGORITHM = 'ES256';
const base64url = (bytes: Buffer) => bytes.toString('base64url');

async function signingKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(ALGORITHM, { extractable: true });
  const kid = base64url(randomBytes(8));
  return { kid, privateKey, publicJwk: { ...(await exportJWK(publicKey)), kid, alg: ALGORITHM, use: 'sig' } };
}

export const defaultTestPeople: TestPerson[] = [
  { subject: 'test-administrator', name: 'Test Administrator' },
  { subject: 'test-person', name: 'Test Person' },
];

export async function startTestIssuer(options: TestIssuerOptions = {}): Promise<TestIssuer> {
  if (process.env.NODE_ENV === 'production') throw new Error('The test issuer never runs with NODE_ENV=production');
  const people = options.people ?? defaultTestPeople;
  const clients = options.clients ?? [];
  const tokenSeconds = options.tokenSeconds ?? 300;
  let key = await signingKey();
  const codes = new Map<string, PendingCode>();
  const refreshes = new Map<string, Refresh>();
  const requests = new Map<string, number>();
  let url = '';

  const now = () => Math.floor(Date.now() / 1000);
  async function mint(claims: MintOptions): Promise<string> {
    const signer = claims.unpublishedKey ? await signingKey() : key;
    const issuedAt = now();
    const person = people.find((candidate) => candidate.subject === claims.subject);
    const authTime = claims.authTime === undefined ? issuedAt : claims.authTime;
    const jwt = new SignJWT({
      ...(person ? { name: person.name } : {}),
      ...(authTime === null ? {} : { auth_time: authTime }),
      ...(claims.nonce ? { nonce: claims.nonce } : {}),
      azp: claims.audience ?? clients[0]?.clientId ?? 'ledger-test',
    })
      .setProtectedHeader({ alg: ALGORITHM, kid: signer.kid, typ: 'JWT' })
      .setIssuer(claims.issuer ?? url)
      .setSubject(claims.subject)
      .setAudience(claims.audience ?? clients[0]?.clientId ?? 'ledger-test')
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + (claims.expiresInSeconds ?? tokenSeconds));
    if (claims.notBeforeSeconds !== undefined) jwt.setNotBefore(issuedAt + claims.notBeforeSeconds);
    return jwt.sign(signer.privateKey);
  }

  function json(response: ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  }
  function refuse(response: ServerResponse, error: string, description: string) {
    json(response, 400, { error, error_description: description });
  }
  async function form(request: IncomingMessage): Promise<URLSearchParams> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }
  const escapeHtml = (value: string) =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

  function authorize(request: URL, response: ServerResponse) {
    const query = request.searchParams;
    const client = clients.find((candidate) => candidate.clientId === query.get('client_id'));
    const redirectUri = query.get('redirect_uri') ?? '';
    if (!client || !client.redirectUris.includes(redirectUri))
      return refuse(response, 'invalid_request', 'Unknown client or redirect URI');
    const back = new URL(redirectUri);
    const state = query.get('state');
    if (state) back.searchParams.set('state', state);
    back.searchParams.set('iss', url);
    const fail = (error: string) => {
      back.searchParams.set('error', error);
      response.writeHead(302, { location: back.toString() });
      response.end();
    };
    if (query.get('response_type') !== 'code') return fail('unsupported_response_type');
    const challenge = query.get('code_challenge');
    if (!challenge || query.get('code_challenge_method') !== 'S256') return fail('invalid_request');
    const subject = query.get('login_hint');
    if (!subject) {
      // Each link signs in one test person: there is no password, by design.
      const links = people
        .map((person) => {
          const choose = new URL(request);
          choose.searchParams.set('login_hint', person.subject);
          return `<li><a href="${escapeHtml(choose.pathname + choose.search)}">${escapeHtml(person.name)}</a> <code>${escapeHtml(person.subject)}</code></li>`;
        })
        .join('');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(
        `<!doctype html><meta charset="utf-8"><title>Test issuer</title><h1>Test issuer</h1><p>For tests and local development only. Choose who signs in.</p><ul>${links}</ul>`,
      );
      return;
    }
    if (!people.some((person) => person.subject === subject)) return fail('access_denied');
    const code = base64url(randomBytes(24));
    const nonce = query.get('nonce');
    codes.set(code, {
      clientId: client.clientId,
      redirectUri,
      challenge,
      ...(nonce ? { nonce } : {}),
      subject,
      authTime: now(),
      expiresAt: Date.now() + 60_000,
    });
    back.searchParams.set('code', code);
    response.writeHead(302, { location: back.toString() });
    response.end();
  }

  async function tokens(clientId: string, subject: string, authTime: number, nonce?: string) {
    const refreshToken = base64url(randomBytes(24));
    refreshes.set(refreshToken, { clientId, subject, authTime });
    const idToken = await mint({ subject, audience: clientId, authTime, ...(nonce ? { nonce } : {}) });
    return {
      token_type: 'Bearer',
      id_token: idToken,
      access_token: idToken,
      expires_in: tokenSeconds,
      refresh_token: refreshToken,
    };
  }

  async function token(request: IncomingMessage, response: ServerResponse) {
    const body = await form(request);
    const grant = body.get('grant_type');
    if (grant === 'authorization_code') {
      const code = body.get('code') ?? '';
      const pending = codes.get(code);
      codes.delete(code);
      if (
        !pending ||
        pending.expiresAt < Date.now() ||
        pending.clientId !== body.get('client_id') ||
        pending.redirectUri !== body.get('redirect_uri')
      )
        return refuse(response, 'invalid_grant', 'The code is unknown, used or expired');
      const verifier = body.get('code_verifier') ?? '';
      if (base64url(createHash('sha256').update(verifier).digest()) !== pending.challenge)
        return refuse(response, 'invalid_grant', 'The code verifier does not match');
      return json(response, 200, await tokens(pending.clientId, pending.subject, pending.authTime, pending.nonce));
    }
    if (grant === 'refresh_token') {
      const presented = body.get('refresh_token') ?? '';
      const refresh = refreshes.get(presented);
      refreshes.delete(presented);
      if (!refresh || refresh.clientId !== body.get('client_id'))
        return refuse(response, 'invalid_grant', 'The refresh token is unknown or used');
      return json(response, 200, await tokens(refresh.clientId, refresh.subject, refresh.authTime));
    }
    return refuse(response, 'unsupported_grant_type', 'Only authorization_code and refresh_token');
  }

  const server = createServer((request, response) => {
    const requested = new URL(request.url ?? '/', url);
    requests.set(requested.pathname, (requests.get(requested.pathname) ?? 0) + 1);
    // A browser calls discovery, keys and the token endpoint from the web app's origin.
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'content-type');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      return response.end();
    }
    const route = `${request.method} ${requested.pathname}`;
    const handle = async () => {
      if (route === 'GET /.well-known/openid-configuration')
        return json(response, 200, {
          issuer: url,
          authorization_endpoint: `${url}/authorize`,
          token_endpoint: `${url}/token`,
          jwks_uri: `${url}/jwks`,
          end_session_endpoint: `${url}/logout`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: [ALGORITHM],
          code_challenge_methods_supported: ['S256'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          claims_supported: ['sub', 'name', 'auth_time', 'nonce'],
        });
      if (route === 'GET /jwks') return json(response, 200, { keys: [key.publicJwk] });
      if (route === 'GET /authorize') return authorize(requested, response);
      if (route === 'POST /token') return token(request, response);
      if (route === 'POST /rotate') {
        await rotate();
        return json(response, 200, { kid: key.kid });
      }
      if (route === 'GET /logout') {
        const back = requested.searchParams.get('post_logout_redirect_uri');
        const allowed = clients.some((client) =>
          client.redirectUris.some((uri) => back && new URL(uri).origin === new URL(back).origin),
        );
        response.writeHead(allowed ? 302 : 200, allowed ? { location: back! } : { 'content-type': 'text/plain' });
        return response.end(allowed ? undefined : 'Signed out of the test issuer.');
      }
      json(response, 404, { error: 'not_found' });
    };
    handle().catch(() => json(response, 500, { error: 'server_error' }));
  });

  async function rotate() {
    key = await signingKey();
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  url = `http://${options.host ?? '127.0.0.1'}:${address.port}`;
  return {
    url,
    server,
    mint,
    rotate,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
