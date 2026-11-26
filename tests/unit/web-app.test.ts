import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { isWebAppRequest, registerWebApp, webAppFile } from '../../apps/api/src/web-app.js';

const fastify = createRequire(new URL('../../apps/api/package.json', import.meta.url))('fastify') as (
  options?: object,
) => FastifyInstance;

describe('the web app served from the API origin', () => {
  let directory: string;
  let app: FastifyInstance;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ledger-web-'));
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), '<!doctype html><title>Ledger</title>');
    await writeFile(join(directory, 'assets', 'app-1234.js'), 'console.log(1)');
    app = fastify();
    app.get('/v1/me', async () => ({ ok: true }));
    registerWebApp(app, directory);
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('answers pages and files, never API paths', () => {
    expect(isWebAppRequest('GET', '/')).toBe(true);
    expect(isWebAppRequest('HEAD', '/assets/app.js')).toBe(true);
    expect(isWebAppRequest('GET', '/v1/flights')).toBe(false);
    expect(isWebAppRequest('GET', '/v1')).toBe(false);
    expect(isWebAppRequest('POST', '/')).toBe(false);
  });

  it('never leaves its folder', () => {
    expect(webAppFile('/srv/web', '/../etc/passwd')).toBeUndefined();
    expect(webAppFile('/srv/web', '/%2e%2e/%2e%2e/etc/passwd')).toBeUndefined();
    expect(webAppFile('/srv/web', '/assets/../index.html')).toBe('/srv/web/index.html');
    expect(webAppFile('/srv/web', '/a/%00')).toBeUndefined();
    expect(webAppFile('/srv/web', '/%E0%A4%A')).toBeUndefined();
    expect(webAppFile('/srv/web', '/')).toBe('/srv/web/index.html');
  });

  it('serves hashed assets for a year, a screen as index.html, and a missing file as 404', async () => {
    const asset = await app.inject({ method: 'GET', url: '/assets/app-1234.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const screen = await app.inject({ method: 'GET', url: '/people?tab=sources' });
    expect(screen.statusCode).toBe(200);
    expect(screen.body).toContain('<title>Ledger</title>');
    expect(screen.headers['cache-control']).toBe('no-cache');
    // A rule pack's id has a dot in it; the address is still a screen.
    const pack = await app.inject({ method: 'GET', url: '/rules/coverage/ledger.part107' });
    expect(pack.statusCode).toBe(200);
    expect(pack.body).toContain('<title>Ledger</title>');
    expect((await app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/%2e%2e/outside.txt' })).statusCode).toBe(404);
    const api = await app.inject({ method: 'GET', url: '/v1/unknown' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ error: 'Not Found' });
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).json()).toEqual({ ok: true });
  });

  it('serves the page a link to produced records opens to no cache, no other site and no search', async () => {
    const page = await app.inject({ method: 'GET', url: '/shared' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>Ledger</title>');
    expect(page.headers).toMatchObject({
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
    });
  });
});
