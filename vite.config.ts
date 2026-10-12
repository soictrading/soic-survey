import { defineConfig } from "vite";

// Builds the web client into dist/client, which the Worker serves as static assets.
// In development, /api is proxied to `wrangler dev` on port 8787.
export default defineConfig({
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
