/**
 * The one place the web app's requests leave the page. Normally that is the browser's fetch.
 * A scripted session can stand in a recorder or a replay, so a recorded scene can run with no
 * server at all (the hosted demonstration).
 *
 * Build-time switches must be written inline, as `import.meta.env.DEV ||
 * import.meta.env.VITE_LEDGER_ENV === 'demo'`, at every use. An imported constant such as
 * `scripted` is not folded away, so a branch guarded by it, and any import inside it, ships in an
 * ordinary production build. `pnpm check:production-build` fails if demo code reaches apps/web/dist.
 */

export type Mode = 'live' | 'record' | 'replay';

/** A demonstration build has no API behind it: every response comes from a recording. */
export const demonstration = import.meta.env.VITE_LEDGER_ENV === 'demo';

/** Scripted sessions exist only in local development and in a demonstration build. */
export const scripted = import.meta.env.DEV || demonstration;

const browserFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export function mode(): Mode {
  if (demonstration) return 'replay';
  if (!scripted) return 'live';
  const query = new URLSearchParams(window.location.search);
  if (query.get('record') === '1') return 'record';
  if (query.get('replay') === '1') return 'replay';
  return 'live';
}

let current: typeof fetch = browserFetch;

if ((import.meta.env.DEV || import.meta.env.VITE_LEDGER_ENV === 'demo') && mode() === 'replay') {
  // Loaded on first use, so a recording costs nothing until something asks for it.
  current = async (input, init) => {
    const { replayFetch } = await import('./autopilot/session.js');
    return replayFetch(input, init);
  };
}

export function useFetch(next: typeof fetch | null): void {
  current = next ?? browserFetch;
}

export const realFetch = browserFetch;

export const appFetch: typeof fetch =
  import.meta.env.DEV || import.meta.env.VITE_LEDGER_ENV === 'demo'
    ? (input, init) => current(input, init)
    : browserFetch;
