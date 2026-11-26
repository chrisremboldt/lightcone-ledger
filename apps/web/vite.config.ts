import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

function pdfAssets(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
  const prefix = '/pdfjs-assets/6.4.299/';
  const files = new Map<string, string>();
  function collect(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else files.set(`${prefix}${relative(root, path).split('\\').join('/')}`, path);
    }
  }
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs', 'web/images']) collect(join(root, directory));
  return {
    name: 'ledger-pdf-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = files.get(new URL(request.url ?? '/', 'http://localhost').pathname);
        if (!path) return next();
        const contentTypes: Record<string, string> = {
          '.wasm': 'application/wasm',
          '.js': 'text/javascript',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.ttf': 'font/ttf',
          '.otf': 'font/otf',
        };
        response.setHeader('Content-Type', contentTypes[extname(path)] ?? 'application/octet-stream');
        createReadStream(path).pipe(response);
      });
    },
    generateBundle() {
      for (const [url, path] of files)
        this.emitFile({ type: 'asset', fileName: url.slice(1), source: readFileSync(path) });
    },
  };
}

/** The manifest that lets a phone install the web app. */
const manifest = JSON.stringify(
  {
    name: 'Ledger',
    short_name: 'Ledger',
    description: 'Ledger operations: an attributable, changing flight record.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0d0d0d',
    theme_color: '#0d0d0d',
    icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  },
  null,
  2,
);

/** The service worker, with the version and the files to keep when it installs written above it. */
function serviceWorker(version: string, files: readonly string[]): string {
  const source = readFileSync(fileURLToPath(new URL('./service-worker.js', import.meta.url)), 'utf8');
  return `const APP_VERSION = ${JSON.stringify(version)};\nconst APP_FILES = ${JSON.stringify(files)};\n${source}`;
}

/**
 * Makes the web app installable and able to open without a connection (docs/design/offline-entry.md): a manifest and
 * a service worker that keeps the files the first screen needs. A demonstration build gets neither: it keeps nothing.
 */
function appShell(demonstration: boolean): Plugin {
  return {
    name: 'ledger-app-shell',
    enforce: 'post',
    transformIndexHtml() {
      return demonstration ? [] : [{ tag: 'link', attrs: { rel: 'manifest', href: '/manifest.webmanifest' } }];
    },
    configureServer(server) {
      // In development the worker keeps what is fetched, as it is fetched; there is no build to list.
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (path === '/sw.js') {
          response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          response.setHeader('Cache-Control', 'no-cache');
          response.end(serviceWorker('development', []));
        } else if (path === '/manifest.webmanifest' && !demonstration) {
          response.setHeader('Content-Type', 'application/manifest+json');
          response.end(manifest);
        } else next();
      });
    },
    generateBundle(_options, bundle) {
      if (demonstration) return;
      // The first screen: the page, the entry script and what it imports at once, with their styles and fonts.
      const files = new Set<string>(['/', '/favicon.svg', '/manifest.webmanifest']);
      const visit = (name: string) => {
        const chunk = bundle[name];
        if (!chunk || chunk.type !== 'chunk' || files.has(`/${name}`)) return;
        files.add(`/${name}`);
        for (const css of chunk.viteMetadata?.importedCss ?? []) files.add(`/${css}`);
        for (const asset of chunk.viteMetadata?.importedAssets ?? []) files.add(`/${asset}`);
        chunk.imports.forEach(visit);
      };
      for (const [name, chunk] of Object.entries(bundle)) if (chunk.type === 'chunk' && chunk.isEntry) visit(name);
      const listed = [...files].filter((file) => !file.startsWith('/pdfjs-assets/')).sort();
      // The version changes whenever a listed file does: their names carry their content's hash.
      const version = createHash('sha256').update(listed.join('\n')).digest('hex').slice(0, 16);
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: manifest });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorker(version, listed) });
    },
  };
}

const envDir = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  // The ports come from the checkout's .env, so a second stack on one computer runs on ports of its own: the web app
  // on LEDGER_WEB_PORT, the API it forwards to on PORT. A port already taken stops the web app instead of moving it.
  const env = loadEnv(mode, envDir, '');
  const api = `http://localhost:${env.PORT || '4000'}`;
  return {
    plugins: [react(), pdfAssets(), appShell(env.VITE_LEDGER_ENV === 'demo')],
    envDir,
    define: {
      __LEDGER_FIXTURES__: JSON.stringify(
        fileURLToPath(new URL('../api/fixtures/utility-documents/', import.meta.url)),
      ),
    },
    optimizeDeps: { include: ['pdfjs-dist', 'pdfjs-dist/web/pdf_viewer.mjs'] },
    server: {
      port: Number(env.LEDGER_WEB_PORT || '5173'),
      strictPort: true,
      proxy: { '/v1': api, '/health': api },
    },
    build: { target: 'es2023' },
  };
});
