import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // GitHub Actions sets GITHUB_ACTIONS=true; the Pages site lives at /crboard/.
  // Local dev keeps base = '/' so nothing changes in development.
  base: process.env.GITHUB_ACTIONS ? "/crboard/" : "/",
  server: {
    port: 5173,
  },
});
