import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: r('./src'),
  // Relative base is mandatory: the packaged app loads dist/index.html via file://.
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': r('./src'),
      '@shared': r('./shared'),
    },
  },
  server: {
    port: 5173,
    strictPort: true, // dev:electron waits on this exact port
  },
  build: {
    outDir: r('./dist'),
    emptyOutDir: true,
  },
});
