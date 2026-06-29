import { defineConfig } from 'vite'

// Simple Vite config. The app is a vanilla Three.js single-page app.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: false,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
})
