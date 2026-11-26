import { DomainError } from '@ledger/persistence';

export interface BucketSettings {
  /** Requests a second the bucket refills by. */
  rate: number;
  /** Requests the bucket holds: how many can arrive at once. */
  burst: number;
}

export interface RequestLimitSettings {
  enabled: boolean;
  /** People, services and an operator's agent. */
  ordinary: BucketSettings;
  /** Credentials of sources, which deliver observations: an adapter sends many. */
  source: BucketSettings;
}

export const DEFAULT_REQUEST_LIMITS = {
  ordinary: { rate: 20, burst: 300 },
  source: { rate: 200, burst: 2000 },
} as const satisfies Omit<RequestLimitSettings, 'enabled'>;

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const text = env[name]?.trim();
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number; it is ${text}`);
  return value;
}

/**
 * The request limit from the environment. It is on unless `LEDGER_REQUEST_LIMIT=off`, except with `LEDGER_ENV=local`
 * or `test`, where it is off unless `LEDGER_REQUEST_LIMIT=on`: the simulated day, the demonstration recorder, the
 * browser tests and the integration tests send many requests with one credential.
 */
export function requestLimitSettings(env: NodeJS.ProcessEnv, ledgerEnv: string): RequestLimitSettings {
  const switched = env.LEDGER_REQUEST_LIMIT?.trim().toLowerCase();
  if (switched && switched !== 'on' && switched !== 'off')
    throw new Error(`LEDGER_REQUEST_LIMIT must be on or off; it is ${switched}`);
  return {
    enabled: switched ? switched === 'on' : ledgerEnv !== 'local' && ledgerEnv !== 'test',
    ordinary: {
      rate: positive(env, 'LEDGER_REQUEST_RATE', DEFAULT_REQUEST_LIMITS.ordinary.rate),
      burst: positive(env, 'LEDGER_REQUEST_BURST', DEFAULT_REQUEST_LIMITS.ordinary.burst),
    },
    source: {
      rate: positive(env, 'LEDGER_SOURCE_REQUEST_RATE', DEFAULT_REQUEST_LIMITS.source.rate),
      burst: positive(env, 'LEDGER_SOURCE_REQUEST_BURST', DEFAULT_REQUEST_LIMITS.source.burst),
    },
  };
}

interface Bucket {
  tokens: number;
  at: number;
  settings: BucketSettings;
}

// Past this many credentials held, full buckets are dropped, at most once a second: a full bucket is the same as none.
const SWEEP_AT = 10_000;

/** The API's answer to a request over its credential's limit, in its usual error shape. */
export function requestLimitRefusal(waitSeconds: number, settings: BucketSettings): DomainError {
  return new DomainError(
    429,
    'request_limit',
    `This credential sent more requests than this Ledger accepts from one credential (${settings.burst} at once, then ${settings.rate} a second). Wait ${waitSeconds} s and send the request again.`,
    { retryAfterSeconds: waitSeconds },
  );
}

/**
 * A token bucket per credential, held in this process's memory only: two API processes allow twice as much. The key
 * is a digest of the credential, never the credential itself.
 */
export class RequestLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private sweptAt = 0;

  constructor(
    private readonly settings: RequestLimitSettings,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one request from the credential's bucket. Undefined when admitted, else the seconds to wait. */
  admit(credential: string, principalKind: string | undefined): number | undefined {
    const settings = this.settingsFor(principalKind);
    const now = this.now();
    const bucket = this.buckets.get(credential) ?? { tokens: settings.burst, at: now, settings };
    bucket.tokens = Math.min(settings.burst, bucket.tokens + ((now - bucket.at) / 1000) * settings.rate);
    bucket.at = now;
    bucket.settings = settings;
    this.buckets.set(credential, bucket);
    if (bucket.tokens < 1) return Math.max(1, Math.ceil((1 - bucket.tokens) / settings.rate));
    bucket.tokens -= 1;
    if (this.buckets.size > SWEEP_AT && now - this.sweptAt >= 1000) this.sweep(now);
    return undefined;
  }

  settingsFor(principalKind: string | undefined): BucketSettings {
    return principalKind === 'source' ? this.settings.source : this.settings.ordinary;
  }

  /** How many credentials have a bucket in memory. */
  get size(): number {
    return this.buckets.size;
  }

  private sweep(now: number): void {
    this.sweptAt = now;
    for (const [key, bucket] of this.buckets)
      if (bucket.tokens + ((now - bucket.at) / 1000) * bucket.settings.rate >= bucket.settings.burst)
        this.buckets.delete(key);
  }
}
