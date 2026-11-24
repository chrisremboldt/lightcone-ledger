export function boundedOperationFetcher(
  apiUrl: string,
  fetcher: typeof fetch,
  cancellation?: AbortSignal,
): typeof fetch {
  const origin = new URL(apiUrl).origin;
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      url.hash ||
      (url.pathname !== '/openapi.json' && !url.pathname.startsWith('/v1/'))
    )
      throw new Error('Operation API request escaped its pinned origin');
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      ...(cancellation ? [cancellation] : []),
      ...(init?.signal ? [init.signal] : []),
    ]);
    const timer = setTimeout(() => controller.abort(new Error('Operation API response timed out')), 5000);
    let response: Response | undefined;
    try {
      response = await fetcher(url, { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store', signal });
      if (response.redirected || (response.status >= 300 && response.status < 400))
        throw new Error('Operation API redirects are unsupported');
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (reader) {
        const cancel = () => {
          void reader.cancel().catch(() => {});
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          while (true) {
            const item = await reader.read();
            signal.throwIfAborted();
            if (item.done) break;
            length += item.value.byteLength;
            if (length > 4 * 1024 * 1024) throw new Error('Operation API response exceeds its byte bound');
            chunks.push(item.value);
          }
        } finally {
          signal.removeEventListener('abort', cancel);
          cancel();
          reader.releaseLock();
        }
      }
      signal.throwIfAborted();
      return new Response(length ? Buffer.concat(chunks, length) : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  };
}
