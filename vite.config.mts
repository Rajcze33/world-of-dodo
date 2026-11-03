// The game page: Vite builds client/ into client/dist, which the server sends (server/server.js). In development `npm run dev`
// serves client/ on :5173 with live reload and passes /ws to the game server (`npm start`, :3000).
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'app',                 // the built scripts; /assets is the game's own images (client/public/assets)
    chunkSizeWarningLimit: 8000,      // Babylon.js is one big chunk on purpose: the first load may take a moment
  },
  server: {
    proxy: { '/ws': { target: 'ws://localhost:3000', ws: true } },
  },
});
