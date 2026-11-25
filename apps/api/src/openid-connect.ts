import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type FetchImplementation,
  type JWTPayload,
} from 'jose';
import type { SignInConfiguration } from '@ledger/contracts';
import { DomainError } from '@ledger/persistence';

type Environment = 'local' | 'test' | 'staging';

/** One OpenID Connect issuer whose tokens the API accepts. */
export interface IssuerSetting {
  /** Exactly the `iss` claim of the issuer's tokens. */
  issuer: string;
  /** The client the web app signs in as; every accepted token must carry it as its audience. */
  clientId: string;
  /** What people see for this issuer on the sign-in and People screens. */
  label?: string;
  /** Requires an `azp` claim naming the client or one of the web app's origins, for a provider that sets it so. */
  checkAuthorizedParty?: boolean;
}

export interface SignInSettings {
  deploymentName: string;
  issuers: IssuerSetting[];
}

/** The identity a verified token proves. authTime is when the person last signed in at the provider, in seconds. */
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  expiresAt: number;
  authTime?: number;
}

export const DEFAULT_DEPLOYMENT_NAME = 'Ledger';
/** Asymmetric signatures only: `none` and the shared-secret HS algorithms are never accepted. */
export const ACCEPTED_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
  'Ed25519',
];
const CLOCK_TOLERANCE_SECONDS = 30;
const DISCOVERY_RETRY_MS = 30_000;
const DISCOVERY_TIMEOUT_MS = 5_000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https everywhere; plain http only to this machine, and only in local development and tests. */
export function allowedProviderUrl(value: string, env: Environment): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && env !== 'staging' && LOOPBACK.has(url.hostname);
}

function issuerSetting(value: unknown, env: Environment, where: string): IssuerSetting {
  const entry = value as Partial<Record<keyof IssuerSetting, unknown>> | null;
  if (!entry || typeof entry !== 'object') throw new Error(`${where} must be an object with issuer and clientId`);
  const known = ['issuer', 'clientId', 'label', 'checkAuthorizedParty'];
  const unknown = Object.keys(entry).find((name) => !known.includes(name));
  if (unknown) throw new Error(`${where} has an unknown setting ${unknown}; the settings are ${known.join(', ')}`);
  const { issuer, clientId, label, checkAuthorizedParty } = entry;
  if (typeof issuer !== 'string' || !allowedProviderUrl(issuer, env))
    throw new Error(
      `${where}: the issuer must be an https URL${env === 'staging' ? '' : ' (or http on localhost in local and test)'}`,
    );
  if (typeof clientId !== 'string' || !clientId.trim()) throw new Error(`${where}: clientId is required`);
  if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 80))
    throw new Error(`${where}: label is text of at most 80 characters`);
  if (checkAuthorizedParty !== undefined && typeof checkAuthorizedParty !== 'boolean')
    throw new Error(`${where}: checkAuthorizedParty is true or false`);
  return {
    issuer,
    clientId: clientId.trim(),
    ...(label ? { label: label.trim() } : {}),
    ...(checkAuthorizedParty ? { checkAuthorizedParty } : {}),
  };
}

/**
 * Reads the configured issuers: one with LEDGER_OIDC_ISSUER and LEDGER_OIDC_CLIENT_ID, or several as a JSON list in
 * LEDGER_OIDC_ISSUERS. A wrong setting stops the process at startup rather than refusing every sign-in later.
 */
export function signInSettings(env: Environment, variables: NodeJS.ProcessEnv = process.env): SignInSettings {
  const deploymentName = variables.LEDGER_DEPLOYMENT_NAME?.trim() || DEFAULT_DEPLOYMENT_NAME;
  if (deploymentName.length > 80) throw new Error('LEDGER_DEPLOYMENT_NAME has at most 80 characters');
  const list = variables.LEDGER_OIDC_ISSUERS?.trim();
  const single = variables.LEDGER_OIDC_ISSUER?.trim();
  if (list && single) throw new Error('Set either LEDGER_OIDC_ISSUERS or LEDGER_OIDC_ISSUER, not both');
  let issuers: IssuerSetting[] = [];
  if (list) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(list);
    } catch {
      throw new Error('LEDGER_OIDC_ISSUERS must be a JSON list of {"issuer":"https://…","clientId":"…"}');
    }
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('LEDGER_OIDC_ISSUERS must be a non-empty JSON list');
    issuers = parsed.map((entry, index) => issuerSetting(entry, env, `LEDGER_OIDC_ISSUERS[${index}]`));
  } else if (single) {
    issuers = [
      issuerSetting(
        {
          issuer: single,
          clientId: variables.LEDGER_OIDC_CLIENT_ID,
          ...(variables.LEDGER_OIDC_LABEL?.trim() ? { label: variables.LEDGER_OIDC_LABEL } : {}),
          ...(variables.LEDGER_OIDC_CHECK_AUTHORIZED_PARTY === 'true' ? { checkAuthorizedParty: true } : {}),
        },
        env,
        'LEDGER_OIDC_ISSUER',
      ),
    ];
  } else if (variables.LEDGER_OIDC_CLIENT_ID?.trim()) {
    throw new Error('LEDGER_OIDC_CLIENT_ID is set without LEDGER_OIDC_ISSUER');
  }
  const seen = new Set<string>();
  for (const { issuer } of issuers) {
    if (seen.has(issuer)) throw new Error(`The issuer ${issuer} is configured twice`);
    seen.add(issuer);
  }
  return { deploymentName, issuers };
}

/** The provider endpoints the API learned from an issuer's discovery document. */
export interface ProviderMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  endSessionEndpoint?: string;
}

export interface TokenVerifierOptions {
  issuers: IssuerSetting[];
  env: Environment;
  /** The web app's origins: an `azp` that names one of them is accepted when an issuer checks it. */
  origins: string[];
  fetch?: FetchImplementation & typeof fetch;
  /** How long an unknown key id waits before the keys are fetched again. */
  keyRefetchCooldownMs?: number;
  /** How long fetched keys are used before they are fetched again. */
  keyCacheMaxAgeMs?: number;
}

export interface TokenVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
  metadata(issuer: string): Promise<ProviderMetadata>;
}

const refused = (message = 'The sign-in token is not valid') => new DomainError(401, 'unauthenticated', message);
const unavailable = () =>
  new DomainError(503, 'identity_provider_unavailable', 'The sign-in provider cannot be reached; try again shortly');

function stringClaim(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === 'string' && value ? value : undefined;
}

export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  const fetcher = options.fetch ?? fetch;
  const settings = new Map(options.issuers.map((setting) => [setting.issuer, setting]));
  const discovered = new Map<string, Promise<ProviderMetadata>>();
  const failedAt = new Map<string, number>();
  const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  async function discover(issuer: string): Promise<ProviderMetadata> {
    const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const response = await fetcher(url, {
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (response.status !== 200) throw new Error(`Discovery for ${issuer} answered ${response.status}`);
    const document = (await response.json()) as Record<string, unknown>;
    if (document.issuer !== issuer) throw new Error(`Discovery for ${issuer} names another issuer`);
    const endpoint = (name: string, required: boolean) => {
      const value = document[name];
      if (value === undefined && !required) return undefined;
      if (typeof value !== 'string' || !allowedProviderUrl(value, options.env))
        throw new Error(`Discovery for ${issuer} has no usable ${name}`);
      return value;
    };
    const endSession = endpoint('end_session_endpoint', false);
    return {
      issuer,
      authorizationEndpoint: endpoint('authorization_endpoint', true)!,
      tokenEndpoint: endpoint('token_endpoint', true)!,
      jwksUri: endpoint('jwks_uri', true)!,
      ...(endSession ? { endSessionEndpoint: endSession } : {}),
    };
  }

  // One discovery at a time per issuer, kept once it succeeds; a failure is retried no sooner than DISCOVERY_RETRY_MS.
  async function metadata(issuer: string): Promise<ProviderMetadata> {
    if (!settings.has(issuer)) throw refused();
    const known = discovered.get(issuer);
    if (known) return known;
    const lastFailure = failedAt.get(issuer);
    if (lastFailure !== undefined && Date.now() - lastFailure < DISCOVERY_RETRY_MS) throw unavailable();
    const pending = discover(issuer).catch((error: unknown) => {
      discovered.delete(issuer);
      failedAt.set(issuer, Date.now());
      throw error;
    });
    discovered.set(issuer, pending);
    try {
      return await pending;
    } catch {
      throw unavailable();
    }
  }

  async function keys(issuer: string) {
    const existing = keySets.get(issuer);
    if (existing) return existing;
    const { jwksUri } = await metadata(issuer);
    const created = createRemoteJWKSet(new URL(jwksUri), {
      cooldownDuration: options.keyRefetchCooldownMs ?? 30_000,
      cacheMaxAge: options.keyCacheMaxAgeMs ?? 600_000,
      timeoutDuration: DISCOVERY_TIMEOUT_MS,
      [customFetch]: fetcher,
    });
    keySets.set(issuer, created);
    return created;
  }

  async function verify(token: string): Promise<VerifiedIdentity> {
    let issuer: string | undefined;
    try {
      const header = decodeProtectedHeader(token);
      if (typeof header.alg !== 'string' || !ACCEPTED_ALGORITHMS.includes(header.alg)) throw refused();
      issuer = stringClaim(decodeJwt(token), 'iss');
    } catch {
      throw refused();
    }
    // Decided before any network call, so a token naming any other issuer costs the provider nothing.
    const setting = issuer ? settings.get(issuer) : undefined;
    if (!setting) throw refused('The sign-in token comes from an issuer this deployment does not accept');
    const keySet = await keys(setting.issuer);
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keySet, {
        issuer: setting.issuer,
        audience: setting.clientId,
        algorithms: ACCEPTED_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['exp', 'sub'],
      }));
    } catch (error) {
      if (error instanceof errors.JWKSTimeout) throw unavailable();
      if (error instanceof errors.JWTExpired) throw refused('The sign-in token has expired; sign in again');
      throw refused();
    }
    const authorizedParty = stringClaim(payload, 'azp');
    if (setting.checkAuthorizedParty) {
      if (!authorizedParty || ![setting.clientId, ...options.origins].includes(authorizedParty)) throw refused();
    } else if (authorizedParty && authorizedParty !== setting.clientId) throw refused();
    const subject = stringClaim(payload, 'sub');
    if (!subject) throw refused();
    return {
      issuer: setting.issuer,
      subject,
      expiresAt: payload.exp! * 1000,
      ...(typeof payload.auth_time === 'number' ? { authTime: payload.auth_time } : {}),
    };
  }

  return { verify, metadata };
}

/**
 * The line the API logs when it starts with development sign-in on (LEDGER_ENV local or test), so no one mistakes such
 * a start for a server's. None with LEDGER_ENV=staging.
 */
export function developmentSignInNotice(env: Environment): string | undefined {
  if (env === 'staging') return undefined;
  return (
    `Development sign-in is on (LEDGER_ENV=${env}): this API accepts development tokens and the web app offers them. ` +
    'This is a start for one computer that faces no network, not a start for a server; a server runs with ' +
    'LEDGER_ENV=staging and people sign in through an identity provider (docs/guides/deploy.md).'
  );
}

/** What the web app reads before anyone signs in: public values only. */
export async function publicSignInConfiguration(
  settings: SignInSettings,
  verifier: TokenVerifier | null,
  env: Environment,
): Promise<SignInConfiguration> {
  const issuers = await Promise.all(
    settings.issuers.map(async (setting) => {
      const found = verifier ? await verifier.metadata(setting.issuer).catch(() => null) : null;
      return {
        issuer: setting.issuer,
        clientId: setting.clientId,
        label: setting.label ?? new URL(setting.issuer).host,
        ...(found
          ? {
              authorizationEndpoint: found.authorizationEndpoint,
              tokenEndpoint: found.tokenEndpoint,
              ...(found.endSessionEndpoint ? { endSessionEndpoint: found.endSessionEndpoint } : {}),
            }
          : {}),
      };
    }),
  );
  return { deploymentName: settings.deploymentName, issuers, developmentTokens: env !== 'staging' };
}
