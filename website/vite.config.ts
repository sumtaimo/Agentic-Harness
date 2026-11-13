import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// base './' = relative asset paths, so the build works on GitHub Pages under /Agentic-Harness/ (or any sub-path).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
});
