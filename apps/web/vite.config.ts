import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
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

const envDir = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  // The ports come from the checkout's .env, so a second stack on one computer runs on ports of its own: the web app
  // on LEDGER_WEB_PORT, the API it forwards to on PORT. A port already taken stops the web app instead of moving it.
  const env = loadEnv(mode, envDir, '');
  const api = `http://localhost:${env.PORT || '4000'}`;
  return {
    plugins: [react(), pdfAssets()],
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
