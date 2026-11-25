import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
};

/** A request the web app answers: a page or a file, never an API path. */
export function isWebAppRequest(method: string, url: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const path = url.split('?')[0]!;
  return !(path === '/v1' || path.startsWith('/v1/'));
}

/** The file under the web app's folder a path names, or undefined when it would leave the folder. */
export function webAppFile(directory: string, url: string): string | undefined {
  let path: string;
  try {
    path = decodeURIComponent(url.split('?')[0]!);
  } catch {
    return undefined;
  }
  if (path.includes('\0')) return undefined;
  const root = resolve(directory);
  const file = resolve(root, `.${path.endsWith('/') ? `${path}index.html` : path}`);
  return file === root || file.startsWith(`${root}${sep}`) ? file : undefined;
}

async function regularFile(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    return (await stat(path)).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Serves the built web app from the API's own origin, so the image runs both in one process and the web app calls
 * the API with relative URLs. A path that names no file type served here is a screen of the single-page app, even with a
 * dot in an id such as a rule pack's: it gets index.html.
 */
export function registerWebApp(app: FastifyInstance, directory: string): void {
  const index = resolve(directory, 'index.html');
  async function send(request: FastifyRequest, reply: FastifyReply) {
    const path = request.url.split('?')[0]!;
    const file =
      (await regularFile(webAppFile(directory, request.url))) ??
      (contentTypes[extname(path).toLowerCase()] ? undefined : await regularFile(index));
    if (!file)
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' }, requestId: request.id });
    const hashed = file.startsWith(resolve(directory, 'assets') + sep);
    return reply
      .header('Content-Type', contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream')
      .header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache')
      .header('X-Content-Type-Options', 'nosniff')
      .send(await readFile(file));
  }
  app.setNotFoundHandler((request, reply) => {
    if (isWebAppRequest(request.method, request.url)) return send(request, reply);
    // The same answer Fastify gives an unknown route when no web app is served.
    return reply
      .code(404)
      .send({ message: `Route ${request.method}:${request.url} not found`, error: 'Not Found', statusCode: 404 });
  });
}
