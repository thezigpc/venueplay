import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: http://localhost:5173 with /api proxied to core. Production: core serves dist/.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:7100" } },
});
