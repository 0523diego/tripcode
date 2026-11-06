import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import tripcode from './vite-plugin-tripcode.ts';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [tripcode()],
  // Vite 8 transforms TS/JSX with Oxc (no @vitejs/plugin-react needed).
  // React 17+ automatic runtime: no `import React` in .tsx files.
  oxc: {
    jsx: { runtime: 'automatic', importSource: 'react' },
  },
  server: {
    fs: { allow: [root] },
  },
});
