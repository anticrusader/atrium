import { defineConfig } from 'vite'

// Simple Vite config. The app is a vanilla Three.js single-page app.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 4726, // moved off the common 5173 to avoid dev-server collisions (embedded in Memex)
    open: false,
    strictPort: false,
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
})
