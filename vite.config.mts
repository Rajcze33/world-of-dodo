// The game page: Vite builds client/ into client/dist, which the server sends (server/server.js). In development `npm run dev`
// serves client/ on :5173 with live reload and passes /ws to the game server (`npm start`, :3000).
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'app',                 // the built scripts; /assets is the game's own images (client/public/assets)
    // World of DODO, issue #31: the page's script (src/entry.ts) is small and loads the game in stages by import(): Babylon.js with
    // the engine (core/engine.ts) and the map (client/shared/map.ts) side by side, then the rest of the game (main.ts). Those stages
    // are big chunks on purpose (the join form works meanwhile, see entry.ts): no warning for them.
    chunkSizeWarningLimit: 8000,
    // World of DODO, issue #31: Babylon.js's modules that more than one chunk uses go into one chunk (babylon-*.js), which the
    // engine's stage loads. Left to itself, the bundler gave every set of stages and shaders that shares a module a chunk of its
    // own once the game came in three dynamic stages: 163 files at the first load instead of 33, mostly tiny shader includes, and
    // 6.7 % more brotli bytes (each file compressed alone). Grouped: 7 files, the same bytes as one script before. The shaders that
    // only one material needs stay in their own chunks, loaded when it is first drawn, as before; the map stays a chunk of its own.
    // Vite's preload helper gets a chunk of its own first: the Babylon group takes its modules' dependencies along, the helper among
    // them, and the page's script, which needs the helper for its import()s, would then wait for all of Babylon.js
    // (tools/smoke.js checks that the entry and what it imports stay light).
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'preload', test: /preload-helper/, priority: 1 },
            { name: 'babylon', test: /node_modules[\\/]@babylonjs/, minShareCount: 2 },
          ],
        },
      },
    },
  },
  server: {
    proxy: { '/ws': { target: 'ws://localhost:3000', ws: true } },
  },
});
