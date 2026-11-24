export class OracleReadError extends Error {
  constructor(
    public readonly status: 'pending' | 'unverifiable',
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OracleReadError';
  }
}

export interface OracleApiLimits {
  requests?: number;
  bytes?: number;
  timeoutMs?: number;
  requestTimeoutMs?: number;
}

const defaults = {
  requests: 256,
  bytes: 8 * 1024 * 1024,
  timeoutMs: 30_000,
  requestTimeoutMs: 5000,
};

function readLimits(value: OracleApiLimits): typeof defaults {
  if (
    !value ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    throw new OracleReadError('unverifiable', 'invalid_limits', 'Oracle read limits must be an object');
  if (Object.keys(value).some((key) => !Object.hasOwn(defaults, key)))
    throw new OracleReadError('unverifiable', 'invalid_limits', 'Oracle read limits contain an unknown setting');
  const limits = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof typeof defaults>) {
    const setting = value[key] === undefined ? defaults[key] : value[key]!;
    if (
      !Number.isSafeInteger(setting) ||
      setting < 1 ||
      ((key === 'timeoutMs' || key === 'requestTimeoutMs') && setting > 2_147_483_647)
    )
      throw new OracleReadError('unverifiable', 'invalid_limits', `Oracle ${key} must be a positive bounded integer`);
    limits[key] = setting;
  }
  return limits;
}

export class OracleApi {
  private readonly base: URL;
  private readonly limits: typeof defaults;
  private readonly deadline: number;
  private requestCount = 0;
  private responseBytes = 0;

  constructor(
    baseUrl: string,
    private readonly token: string,
    limits: OracleApiLimits = {},
    private readonly fetcher: typeof fetch = fetch,
  ) {
    try {
      this.base = new URL(baseUrl);
      if (
        !['http:', 'https:'].includes(this.base.protocol) ||
        this.base.username ||
        this.base.password ||
        this.base.search ||
        this.base.hash ||
        this.base.pathname !== '/'
      )
        throw new Error();
    } catch {
      throw new OracleReadError('unverifiable', 'invalid_base_url', 'Oracle API requires an HTTP(S) origin URL');
    }
    if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token))
      throw new OracleReadError('unverifiable', 'invalid_credential', 'Oracle API requires a bearer credential');
    this.limits = readLimits(limits);
    this.deadline = Date.now() + this.limits.timeoutMs;
  }

  usage(): { requests: number; bytes: number } {
    return { requests: this.requestCount, bytes: this.responseBytes };
  }

  async json<T>(path: string): Promise<T> {
    const bytes = await this.read(path, 'application/json');
    let value: T;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
    } catch {
      throw new OracleReadError('unverifiable', 'unsupported_response', 'Oracle API returned invalid JSON');
    }
    if (Date.now() >= this.deadline) throw this.timeoutError();
    return value;
  }

  bytes(path: string): Promise<Uint8Array> {
    return this.read(path, 'application/octet-stream');
  }

  private url(path: string): URL {
    try {
      if (
        typeof path !== 'string' ||
        (path !== '/openapi.json' && !/^\/v1(?:\/|\?|$)/.test(path)) ||
        /[\s\\#]/.test(path)
      )
        throw new Error();
      for (const segment of path.split('?')[0]!.split('/')) {
        const decoded = decodeURIComponent(segment);
        if (decoded === '.' || decoded === '..' || /[\/\\]/.test(decoded)) throw new Error();
      }
      const url = new URL(path, this.base);
      if (url.origin !== this.base.origin || (path !== '/openapi.json' && !/^\/v1(?:\/|$)/.test(url.pathname)))
        throw new Error();
      return url;
    } catch {
      throw new OracleReadError(
        'unverifiable',
        'invalid_path',
        'Oracle reads require a relative /v1 API path or /openapi.json',
      );
    }
  }

  private async read(path: string, accept: string): Promise<Uint8Array> {
    const url = this.url(path);
    if (this.requestCount >= this.limits.requests)
      throw new OracleReadError('unverifiable', 'request_limit', 'Oracle request budget exceeded');
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new OracleReadError('pending', 'deadline_exceeded', 'Oracle read deadline exceeded');
    const controller = new AbortController();
    const expiresAt = Math.min(this.deadline, Date.now() + this.limits.requestTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          const error = this.timeoutError();
          reject(error);
          controller.abort(error);
        },
        Math.max(1, expiresAt - Date.now()),
      );
    });
    let response: Response | undefined;
    try {
      this.requestCount++;
      const request = this.fetcher(url.toString(), {
        method: 'GET',
        headers: { authorization: `Bearer ${this.token}`, accept },
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
      }).then((received) => {
        if (controller.signal.aborted) void received.body?.cancel().catch(() => {});
        return received;
      });
      response = await Promise.race([request, expired]);
      if (Date.now() >= expiresAt) throw this.timeoutError();
      if (response.redirected || (response.status >= 300 && response.status < 400))
        throw new OracleReadError('unverifiable', 'redirect_unsupported', 'Oracle API redirects are unsupported');
      if (response.status === 401 || response.status === 403)
        throw new OracleReadError('unverifiable', 'authority_unavailable', 'Oracle read authority is unavailable');
      if (response.status === 404)
        throw new OracleReadError('pending', 'resource_unavailable', 'Oracle API resource is not available');
      if (response.status >= 500 || response.status === 408 || response.status === 429)
        throw new OracleReadError('pending', 'api_unavailable', `Oracle API returned HTTP ${response.status}`);
      if (!response.ok)
        throw new OracleReadError(
          'unverifiable',
          'unsupported_response',
          `Oracle API returned HTTP ${response.status}`,
        );
      return await Promise.race([this.collect(response, controller.signal, expiresAt), expired]);
    } catch (error) {
      if (error instanceof OracleReadError) throw error;
      throw new OracleReadError('pending', 'api_unavailable', 'Oracle API read is unavailable');
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  }

  private timeoutError(): OracleReadError {
    const totalExpired = Date.now() >= this.deadline;
    return new OracleReadError(
      'pending',
      totalExpired ? 'deadline_exceeded' : 'request_timeout',
      totalExpired ? 'Oracle read deadline exceeded' : 'Oracle API request timed out',
    );
  }

  private async collect(response: Response, signal: AbortSignal, expiresAt: number): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (signal.aborted) throw signal.reason;
        if (Date.now() >= expiresAt) throw this.timeoutError();
        if (done) break;
        this.responseBytes += value.byteLength;
        if (this.responseBytes > this.limits.bytes)
          throw new OracleReadError('unverifiable', 'byte_limit', 'Oracle response byte budget exceeded');
        chunks.push(value);
        length += value.byteLength;
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (Date.now() >= expiresAt) throw this.timeoutError();
      return bytes;
    } finally {
      signal.removeEventListener('abort', cancel);
      cancel();
      reader.releaseLock();
    }
  }
}
