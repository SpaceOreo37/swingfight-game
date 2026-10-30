import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true, // reachable from other devices on your network
    port: 5173,
    // Multiplayer: forward the game socket to the server (npm run dev starts both).
    proxy: {
      '/ws': { target: 'ws://localhost:3001', ws: true },
      '/health': { target: 'http://localhost:3001' },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Three.js in its own file: it rarely changes, so browsers keep it cached between updates.
        manualChunks: { three: ['three'] },
      },
    },
  },
});
