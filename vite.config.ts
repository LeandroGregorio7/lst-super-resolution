import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: process.env.GITHUB_ACTIONS ? '/lst-super-resolution/' : '/',
  build: { sourcemap: false, target: 'es2020' },
});
