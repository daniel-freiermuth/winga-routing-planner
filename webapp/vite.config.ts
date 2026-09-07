import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
const pkg = JSON.parse(readFileSync(resolve(__dir, '../package.json'), 'utf-8')) as { version: string };
const commitHash = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
})();

export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
  root: __dir,

  plugins: [svelte()],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(commitHash),
  },

  build: {
    outDir: '../dist/webapp',
    emptyOutDir: true,
    sourcemap: true,
    // Include .wasm files as assets so wasm-bindgen can fetch them
    assetsInlineLimit: 0,
  },

  worker: {
    format: 'es' as const,
  },

  server: {
    port: 5174,
  },
}));
