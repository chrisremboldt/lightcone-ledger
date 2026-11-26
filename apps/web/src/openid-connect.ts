import type { SignInConfiguration } from '@ledger/contracts';

/**
 * Sign-in through any OpenID Connect provider: the authorization code flow with PKCE, as a public client with no
 * secret. Tokens live in memory only; the PKCE transaction alone is kept in session storage across the redirect.
 */
export type IssuerEntry = SignInConfiguration['issuers'][number];

export interface Transaction {
  issuer: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  verifier: string;
  /** When the transaction began, in seconds; a confirmation must have signed in after it. */
  startedAt: number;
}

export interface TokenSet {
  idToken: string;
  refreshToken?: string;
  /** When the ID token expires, in milliseconds since the epoch. */
  expiresAt: number;
  /** When the person last signed in at the provider, in seconds since the epoch. */
  authTime?: number;
}

export class SignInError extends Error {}
/** The provider did not answer at all, as with no connection: not a refusal, so a sign-in is not ended by it. */
export class ProviderUnreachableError extends SignInError {}

/**
 * A sign-in the provider completed for an account tied to no one in Ledger. It carries only the person's own account,
 * as the API read it from their token, for them to give their administrator.
 */
export class UntiedAccountError extends SignInError {
  constructor(
    message: string,
    readonly issuer: string,
    readonly subject: string,
  ) {
    super(message);
  }
}

/**
 * Asks Ledger who the signed-in account is before the workspace opens. Throws UntiedAccountError when the account is
 * tied to no one; any other answer leaves the workspace to report it.
 */
export async function confirmAccountTied(
  apiUrl: string,
  idToken: string,
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<void> {
  const response = await fetcher(`${apiUrl.replace(/\/$/, '')}/v1/me`, {
    headers: { authorization: `Bearer ${idToken}`, accept: 'application/json' },
    credentials: 'omit',
    cache: 'no-store',
  });
  if (response.status !== 401) return;
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: unknown; message?: unknown; details?: { issuer?: unknown; subject?: unknown } };
  } | null;
  const error = body?.error;
  if (
    error?.code === 'sign_in_account_not_tied' &&
    typeof error.message === 'string' &&
    typeof error.details?.issuer === 'string' &&
    typeof error.details.subject === 'string'
  )
    throw new UntiedAccountError(error.message, error.details.issuer, error.details.subject);
}

const TRANSACTION_KEY = 'ledger.sign-in.transaction';
/** The address a person was on when they began to sign in, to return to once signed in. */
const RETURN_KEY = 'ledger.sign-in.return';
/** The window name a confirmation opens, so the page that loads in it relays the answer instead of signing in. */
export const CONFIRM_WINDOW = 'ledger-confirm-sign-in';
const CALLBACK_MESSAGE = 'ledger-sign-in-callback';
const CLOCK_TOLERANCE_SECONDS = 30;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** The S256 code challenge for a PKCE verifier (RFC 7636). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

export function newTransaction(entry: IssuerEntry, redirectUri: string, nowSeconds: number): Transaction {
  return {
    issuer: entry.issuer,
    clientId: entry.clientId,
    redirectUri,
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(48),
    startedAt: nowSeconds,
  };
}

/** The provider's authorization URL. A confirmation asks for a new sign-in with max_age=0 and prompt=login. */
export async function authorizationUrl(
  entry: IssuerEntry,
  transaction: Transaction,
  options: { confirm?: boolean } = {},
): Promise<string> {
  if (!entry.authorizationEndpoint) throw new SignInError('The sign-in provider cannot be reached');
  const url = new URL(entry.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', transaction.clientId);
  url.searchParams.set('redirect_uri', transaction.redirectUri);
  url.searchParams.set('scope', 'openid profile');
  url.searchParams.set('state', transaction.state);
  url.searchParams.set('nonce', transaction.nonce);
  url.searchParams.set('code_challenge', await pkceChallenge(transaction.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (options.confirm) {
    url.searchParams.set('max_age', '0');
    url.searchParams.set('prompt', 'login');
  }
  return url.toString();
}

const CALLBACK_PARAMETERS = ['code', 'state', 'error', 'error_description', 'iss', 'session_state'];

export function isCallback(href: string): boolean {
  const query = new URL(href).searchParams;
  return query.has('state') && (query.has('code') || query.has('error'));
}

/** The URL without the provider's answer, to put back in the address bar. */
export function withoutCallback(href: string): string {
  const url = new URL(href);
  for (const name of CALLBACK_PARAMETERS) url.searchParams.delete(name);
  return url.toString();
}

/**
 * Where a completed sign-in lands: the place the person opened before signing in, such as a link to a finding, when
 * it is a path on this site; otherwise the address the provider returned to, without its answer.
 */
export function returnAddress(returned: string, saved: string | null): string {
  if (!saved || !saved.startsWith('/') || saved.startsWith('//') || saved.startsWith('/\\')) return returned;
  const url = new URL(returned);
  return new URL(saved, url.origin).toString();
}

/** Reads the provider's answer, refusing one that does not belong to this transaction. */
export function parseCallback(href: string, transaction: Transaction | null): { code: string } {
  const query = new URL(href).searchParams;
  if (!transaction || query.get('state') !== transaction.state)
    throw new SignInError('This sign-in was not started here, or was already used. Sign in again.');
  const issuer = query.get('iss');
  if (issuer !== null && issuer !== transaction.issuer)
    throw new SignInError('The answer came from a different sign-in provider. Sign in again.');
  const error = query.get('error');
  if (error)
    throw new SignInError(
      error === 'access_denied' || error === 'login_required'
        ? 'Sign-in was cancelled or refused at the provider.'
        : `The sign-in provider refused: ${query.get('error_description') ?? error}`,
    );
  const code = query.get('code');
  if (!code) throw new SignInError('The sign-in provider sent no code. Sign in again.');
  return { code };
}

export function idTokenClaims(idToken: string): Record<string, unknown> {
  const [, payload] = idToken.split('.');
  if (!payload) throw new SignInError('The sign-in provider sent an unreadable token');
  try {
    const padded = payload.replaceAll('-', '+').replaceAll('_', '/');
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    throw new SignInError('The sign-in provider sent an unreadable token');
  }
}

/**
 * Checks the ID token the token endpoint returned for this transaction. Its signature is the API's to verify on
 * every request; here the browser checks that the token answers this sign-in and no other.
 */
export function checkIdToken(
  idToken: string,
  expected: { issuer: string; clientId: string; nonce?: string; nowSeconds: number; signedInAfter?: number },
): TokenSet {
  const claims = idTokenClaims(idToken);
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== expected.issuer) throw new SignInError('The token is from a different sign-in provider');
  if (!audience.includes(expected.clientId)) throw new SignInError('The token was issued to a different client');
  if (expected.nonce !== undefined && claims.nonce !== expected.nonce)
    throw new SignInError('The token does not answer this sign-in');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_TOLERANCE_SECONDS < expected.nowSeconds)
    throw new SignInError('The token has already expired');
  const authTime = typeof claims.auth_time === 'number' ? claims.auth_time : undefined;
  if (expected.signedInAfter !== undefined) {
    if (authTime === undefined)
      throw new SignInError(
        'The sign-in provider does not say when you signed in (auth_time), so Ledger cannot accept a signature',
      );
    if (authTime + CLOCK_TOLERANCE_SECONDS < expected.signedInAfter)
      throw new SignInError('The sign-in provider did not ask you to sign in again. Ask your administrator.');
  }
  return { idToken, expiresAt: claims.exp * 1000, ...(authTime !== undefined ? { authTime } : {}) };
}

async function tokenRequest(
  fetcher: typeof fetch,
  entry: IssuerEntry,
  body: Record<string, string>,
): Promise<{ id_token: string; refresh_token?: string }> {
  if (!entry.tokenEndpoint) throw new SignInError('The sign-in provider cannot be reached');
  let response: Response;
  try {
    response = await fetcher(entry.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new ProviderUnreachableError('The sign-in provider cannot be reached');
  }
  const answer = (await response.json().catch(() => null)) as {
    id_token?: unknown;
    refresh_token?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok || typeof answer?.id_token !== 'string')
    throw new SignInError(
      `The sign-in provider did not issue a token${typeof answer?.error === 'string' ? ` (${answer.error})` : ''}`,
    );
  return {
    id_token: answer.id_token,
    ...(typeof answer.refresh_token === 'string' ? { refresh_token: answer.refresh_token } : {}),
  };
}

export async function exchangeCode(
  fetcher: typeof fetch,
  entry: IssuerEntry,
  transaction: Transaction,
  code: string,
  options: { confirm?: boolean; nowSeconds: number },
): Promise<TokenSet> {
  const answer = await tokenRequest(fetcher, entry, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: transaction.redirectUri,
    client_id: transaction.clientId,
    code_verifier: transaction.verifier,
  });
  const tokens = checkIdToken(answer.id_token, {
    issuer: transaction.issuer,
    clientId: transaction.clientId,
    nonce: transaction.nonce,
    nowSeconds: options.nowSeconds,
    ...(options.confirm ? { signedInAfter: transaction.startedAt } : {}),
  });
  return answer.refresh_token ? { ...tokens, refreshToken: answer.refresh_token } : tokens;
}

export async function refreshTokens(
  fetcher: typeof fetch,
  entry: IssuerEntry,
  refreshToken: string,
  nowSeconds: number,
): Promise<TokenSet> {
  const answer = await tokenRequest(fetcher, entry, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: entry.clientId,
  });
  const tokens = checkIdToken(answer.id_token, { issuer: entry.issuer, clientId: entry.clientId, nowSeconds });
  return { ...tokens, refreshToken: answer.refresh_token ?? refreshToken };
}

export function saveTransaction(storage: Storage, transaction: Transaction): void {
  storage.setItem(TRANSACTION_KEY, JSON.stringify(transaction));
}

/** Takes the pending transaction out of storage: it answers exactly one callback. */
export function takeTransaction(storage: Storage): Transaction | null {
  const value = storage.getItem(TRANSACTION_KEY);
  storage.removeItem(TRANSACTION_KEY);
  if (!value) return null;
  try {
    return JSON.parse(value) as Transaction;
  } catch {
    return null;
  }
}

export function redirectUri(location: Location, base: string): string {
  return new URL(base, location.origin).toString();
}

/** In the confirmation window: hands the provider's answer to the page that opened it, and closes. */
export function relayConfirmation(): boolean {
  if (typeof window === 'undefined' || window.name !== CONFIRM_WINDOW || !window.opener) return false;
  if (!isCallback(window.location.href)) return false;
  (window.opener as Window).postMessage({ type: CALLBACK_MESSAGE, href: window.location.href }, window.location.origin);
  window.close();
  return true;
}

/** The signed-in person's tokens, in memory, renewed with the refresh token while the provider grants one. */
export class OpenIdSession {
  private refreshing: Promise<TokenSet> | null = null;
  constructor(
    readonly entry: IssuerEntry,
    private tokens: TokenSet,
    private readonly onEnded: (reason: string) => void,
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  get idToken(): string {
    return this.tokens.idToken;
  }

  /** The ID token to send to the API, renewed shortly before it expires. */
  readonly token = async (): Promise<string | null> => {
    if (this.tokens.expiresAt - Date.now() > 60_000) return this.tokens.idToken;
    const refreshToken = this.tokens.refreshToken;
    if (!refreshToken) return this.end('Your sign-in has ended. Sign in again to continue.');
    this.refreshing ??= refreshTokens(this.fetcher, this.entry, refreshToken, Math.floor(Date.now() / 1000)).finally(
      () => {
        this.refreshing = null;
      },
    );
    try {
      this.tokens = await this.refreshing;
      return this.tokens.idToken;
    } catch (error) {
      // Without a connection the renewal is tried again on the next request; entries kept meanwhile stay this person's.
      if (error instanceof ProviderUnreachableError) throw error;
      return this.end('Your sign-in has ended. Sign in again to continue.');
    }
  };

  private end(reason: string): null {
    this.onEnded(reason);
    return null;
  }

  /**
   * Confirms it is the person by a new sign-in at the provider, in a window of its own so nothing on the page is
   * lost. The window is opened at once, inside the click, so a pop-up blocker allows it.
   */
  readonly confirm = async (): Promise<{ authenticatedAt: string }> => {
    const popup = window.open('about:blank', CONFIRM_WINDOW, 'popup,width=520,height=680');
    if (!popup) throw new SignInError('Allow pop-up windows for this site, then confirm again.');
    const transaction = newTransaction(
      this.entry,
      redirectUri(window.location, import.meta.env.BASE_URL),
      Math.floor(Date.now() / 1000),
    );
    try {
      popup.location.href = await authorizationUrl(this.entry, transaction, { confirm: true });
    } catch (error) {
      popup.close();
      throw error;
    }
    const href = await new Promise<string>((resolve, reject) => {
      const closed = window.setInterval(() => {
        if (!popup.closed) return;
        stop();
        reject(new SignInError('The confirmation window was closed before you signed in.'));
      }, 500);
      const listen = (event: MessageEvent) => {
        const data = event.data as { type?: string; href?: string } | null;
        if (event.origin !== window.location.origin || event.source !== popup || data?.type !== CALLBACK_MESSAGE)
          return;
        stop();
        resolve(String(data.href));
      };
      const stop = () => {
        window.clearInterval(closed);
        window.removeEventListener('message', listen);
      };
      window.addEventListener('message', listen);
    });
    const { code } = parseCallback(href, transaction);
    const tokens = await exchangeCode(this.fetcher, this.entry, transaction, code, {
      confirm: true,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    this.tokens = tokens;
    return { authenticatedAt: new Date(tokens.authTime! * 1000).toISOString() };
  };
}

/** Sends the browser to the provider to sign in; it comes back to this page with a code. */
export async function beginSignIn(entry: IssuerEntry): Promise<void> {
  const transaction = newTransaction(
    entry,
    redirectUri(window.location, import.meta.env.BASE_URL),
    Math.floor(Date.now() / 1000),
  );
  const url = await authorizationUrl(entry, transaction);
  saveTransaction(window.sessionStorage, transaction);
  window.sessionStorage.setItem(RETURN_KEY, `${window.location.pathname}${window.location.search}`);
  window.location.assign(url);
}

/** Finishes a sign-in the provider sent back to this page, if one is pending. */
export async function completeSignIn(
  configuration: SignInConfiguration,
  fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
): Promise<{ entry: IssuerEntry; tokens: TokenSet } | null> {
  const href = window.location.href;
  if (!isCallback(href)) return null;
  const transaction = takeTransaction(window.sessionStorage);
  const returnTo = window.sessionStorage.getItem(RETURN_KEY);
  window.sessionStorage.removeItem(RETURN_KEY);
  window.history.replaceState(window.history.state, '', returnAddress(withoutCallback(href), returnTo));
  const { code } = parseCallback(href, transaction);
  const entry = configuration.issuers.find(
    (candidate) => candidate.issuer === transaction!.issuer && candidate.clientId === transaction!.clientId,
  );
  if (!entry) throw new SignInError('This deployment no longer accepts that sign-in provider.');
  return { entry, tokens: await exchangeCode(fetcher, entry, transaction!, code, { nowSeconds: Date.now() / 1000 }) };
}

/** Signs out of Ledger and, where the provider offers it, of the provider's session too. */
export function endSession(entry: IssuerEntry, idToken: string | null): void {
  if (!entry.endSessionEndpoint) return;
  const url = new URL(entry.endSessionEndpoint);
  url.searchParams.set('client_id', entry.clientId);
  url.searchParams.set('post_logout_redirect_uri', redirectUri(window.location, import.meta.env.BASE_URL));
  if (idToken) url.searchParams.set('id_token_hint', idToken);
  window.location.assign(url.toString());
}

export async function readSignInConfiguration(apiUrl: string): Promise<SignInConfiguration> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/sign-in`, {
      headers: { accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    // No answer at all, as without a connection: the app opened from what this device keeps.
    throw new SignInError('Ledger cannot be reached from this device now. Sign in once there is a connection.');
  }
  if (!response.ok) throw new SignInError('Ledger cannot be reached. Try again shortly.');
  return (await response.json()) as SignInConfiguration;
}
