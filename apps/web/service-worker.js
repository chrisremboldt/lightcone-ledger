// The web app's service worker (docs/design/offline-entry.md). It keeps the app's own files so the app opens without a
// connection, and nothing else: never an answer from the API, never a page opened by a link someone was given.
// The build puts the version and the files the first screen needs above this line (the appShell plugin in
// vite.config.ts): APP_VERSION and APP_FILES.
/* global APP_VERSION, APP_FILES */

const CACHE_PREFIX = 'ledger-app-';
const CACHE = `${CACHE_PREFIX}${APP_VERSION}`;
/** How long a page waits for the network before the kept copy is shown. */
const PAGE_WAIT_MS = 4000;
/** Paths of the API, and pages opened by a link someone was given: never kept, always from the network. */
const NEVER_KEPT = ['/v1', '/health', '/readyz', '/report', '/shared', '/pdfjs-assets'];
const KEPT_DESTINATIONS = ['script', 'style', 'font', 'image', 'manifest', 'worker'];

const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Whether a request is for one of the app's own files, which this worker may keep: a page of the app or a script, style,
 * font, image or manifest of this site, asked for without credentials, outside the API and the linked pages.
 */
function keeps(request, origin) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== origin) return false;
  if (NEVER_KEPT.some((prefix) => under(url.pathname, prefix))) return false;
  if (request.headers.has('authorization')) return false;
  return request.mode === 'navigate' || KEPT_DESTINATIONS.includes(request.destination);
}

/** A response worth keeping: complete, from this site, and not marked as one no cache may keep. */
function keepable(response) {
  return (
    response.ok &&
    response.status === 200 &&
    response.type === 'basic' &&
    !/no-store/i.test(response.headers.get('cache-control') ?? '')
  );
}

/** Built files carry their content's hash in their name, so a kept copy is always the right one. */
const hashed = (url) => new URL(url).pathname.startsWith('/assets/');

async function keep(request, response) {
  if (!keepable(response)) return;
  // A page is kept as the app's one page; anything else a navigation answers is not the app.
  if (request.mode === 'navigate' && !/text\/html/i.test(response.headers.get('content-type') ?? '')) return;
  const cache = await caches.open(CACHE);
  await cache.put(request.mode === 'navigate' ? '/' : request, response);
}

async function fromNetworkFirst(request) {
  const network = fetch(request).then((response) => {
    keep(request, response.clone()).catch(() => undefined);
    return response;
  });
  network.catch(() => undefined);
  const waited =
    request.mode === 'navigate'
      ? new Promise((resolve) => setTimeout(() => resolve(undefined), PAGE_WAIT_MS))
      : new Promise(() => {});
  const kept = async () =>
    request.mode === 'navigate' ? (await caches.open(CACHE)).match('/') : caches.match(request);
  try {
    const first = await Promise.race([network, waited]);
    if (first) return first;
    return (await kept()) ?? (await network);
  } catch (error) {
    const copy = await kept();
    if (copy) return copy;
    throw error;
  }
}

async function fromKeptFirst(request) {
  const copy = await caches.match(request);
  if (copy) return copy;
  const response = await fetch(request);
  keep(request, response.clone()).catch(() => undefined);
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Each file on its own: one missing file does not stop the others from being kept.
      await Promise.all(
        APP_FILES.map(async (path) => {
          try {
            const response = await fetch(path, { cache: 'no-cache', credentials: 'omit' });
            if (keepable(response)) await cache.put(path, response);
          } catch {
            // Kept when it is next fetched.
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // The version before this one is kept, so a page still running it can load a screen it had not opened yet.
      const versions = (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE);
      await Promise.all(versions.slice(0, -1).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!keeps(request, self.location.origin)) return;
  event.respondWith(hashed(request.url) ? fromKeptFirst(request) : fromNetworkFirst(request));
});
