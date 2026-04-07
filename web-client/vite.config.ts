import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import fs from 'node:fs';
import path from 'node:path';

// sqlite-vec-wasm-demo doesn't ship sqlite3-opfs-async-proxy.js, but sqlite3.mjs
// tries to load it relative to itself.  Serve it from @sqlite.org/sqlite-wasm in dev.
const sqliteOpfsProxy = {
  name: 'sqlite-opfs-async-proxy',
  configureServer(server: import('vite').ViteDevServer) {
    const proxyFile = path.resolve(
      __dirname,
      'node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3-opfs-async-proxy.js',
    );
    server.middlewares.use((req, res, next) => {
      if (req.url?.endsWith('sqlite3-opfs-async-proxy.js')) {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(fs.readFileSync(proxyFile));
        return;
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    wasm(),
    topLevelAwait(),
    sqliteOpfsProxy,
    // sqlite3-worker1.js hardcodes "sqlite3.wasm" and "sqlite3-opfs-async-proxy.js"
    // by their original names (no hash).  Vite hashes these when bundling, so the
    // worker's internal fetches 404 in production.  Copy them verbatim into
    // dist/assets/ so they're always reachable at the exact names the worker expects.
    // (sqlite3-worker1.js itself IS referenced by hashed name from the main bundle,
    // so it doesn't need this treatment.)
    viteStaticCopy({
      targets: [
        // sqlite-vec-wasm-demo is a drop-in: same sqlite-wasm build but with the
        // sqlite-vec extension compiled in.  sqlite3-worker1.js loads sqlite3.wasm
        // by name (hardcoded, no hash), so we just swap the binary here and vec0
        // virtual tables become available through the existing promiser setup.
        {
          src: 'node_modules/sqlite-vec-wasm-demo/sqlite3.wasm',
          dest: 'assets',
        },
        // OPFS async proxy is still needed for OPFS persistence.
        {
          src: 'node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3-opfs-async-proxy.js',
          dest: 'assets',
        },
      ],
    }),
  ],
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    // Do NOT pre-bundle these packages — they use new URL(..., import.meta.url)
    // to locate their WASM files.  Pre-bundling rewrites those paths into the
    // Vite deps cache where the WASM is not present, causing a 404 that returns
    // the SPA HTML fallback, which then fails WASM magic-number validation.
    exclude: ['@sqlite.org/sqlite-wasm', 'sqlite-vec-wasm-demo'],
  },
  server: {
    headers: {
      // Required for SharedArrayBuffer (sqlite-wasm OPFS, transformers.js)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
});
