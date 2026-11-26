import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// The web app's service worker keeps the app's own files and never an answer from the API
// (docs/design/offline-entry.md). Its rule is read here from the file the build ships.

const source = readFileSync(new URL('../../apps/web/service-worker.js', import.meta.url), 'utf8');
const origin = 'https://ledger.example.test';

function worker(): { keeps: (request: unknown, origin: string) => boolean; events: string[] } {
  const events: string[] = [];
  const context = {
    URL,
    self: { addEventListener: (name: string) => events.push(name), location: { origin } },
  } as Record<string, unknown>;
  runInNewContext(`const APP_VERSION = 'test';\nconst APP_FILES = [];\n${source}`, context);
  return { keeps: context.keeps as (request: unknown, origin: string) => boolean, events };
}

const request = (
  path: string,
  options: { method?: string; mode?: string; destination?: string; headers?: Record<string, string> } = {},
) => ({
  url: path.startsWith('http') ? path : `${origin}${path}`,
  method: options.method ?? 'GET',
  mode: options.mode ?? 'no-cors',
  destination: options.destination ?? '',
  headers: new Headers(options.headers),
});

describe('the service worker', () => {
  const { keeps, events } = worker();

  it('keeps the app’s pages, scripts, styles, fonts and icons', () => {
    expect(events.sort()).toEqual(['activate', 'fetch', 'install']);
    expect(keeps(request('/', { mode: 'navigate', destination: 'document' }), origin)).toBe(true);
    expect(keeps(request('/records/enter?type=flight.record%401', { mode: 'navigate' }), origin)).toBe(true);
    expect(keeps(request('/assets/index-Brh9WEcg.js', { destination: 'script' }), origin)).toBe(true);
    expect(keeps(request('/assets/index-BYULAjoY.css', { destination: 'style' }), origin)).toBe(true);
    expect(keeps(request('/assets/open-sans-latin-400-normal.woff2', { destination: 'font' }), origin)).toBe(true);
    expect(keeps(request('/favicon.svg', { destination: 'image' }), origin)).toBe(true);
    expect(keeps(request('/manifest.webmanifest', { destination: 'manifest' }), origin)).toBe(true);
    // Development serves modules from the source tree; they are the app's own files too.
    expect(keeps(request('/src/main.tsx', { destination: 'script' }), origin)).toBe(true);
  });

  it('never keeps an answer from the API, a request with credentials, or a page opened by a link', () => {
    for (const path of ['/v1/me', '/v1/operator-records?recordType=flight.record', '/v1', '/health', '/readyz'])
      for (const destination of ['', 'image', 'script', 'document'])
        expect(
          keeps(request(path, { destination, mode: destination === 'document' ? 'navigate' : 'cors' }), origin),
        ).toBe(false);
    expect(keeps(request('/report', { mode: 'navigate' }), origin)).toBe(false);
    expect(keeps(request('/shared', { mode: 'navigate' }), origin)).toBe(false);
    expect(keeps(request('/pdfjs-assets/6.4.299/cmaps/Adobe-GB1-0.bcmap'), origin)).toBe(false);
    // What the app fetches itself is an API answer or a file it reads: never kept.
    expect(keeps(request('/favicon.svg', { mode: 'cors' }), origin)).toBe(false);
    expect(
      keeps(request('/assets/app.js', { destination: 'script', headers: { authorization: 'Bearer x' } }), origin),
    ).toBe(false);
    expect(keeps(request('/', { method: 'POST', mode: 'navigate' }), origin)).toBe(false);
    expect(keeps(request('https://cdn.example.test/app.js', { destination: 'script' }), origin)).toBe(false);
  });
});
