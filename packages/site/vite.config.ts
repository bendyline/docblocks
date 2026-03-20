import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5220,
    strictPort: true,
    open: true,
  },
  optimizeDeps: {
    include: ['monaco-editor'],
  },
});
