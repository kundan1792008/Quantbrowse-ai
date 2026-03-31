import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Allow Tauri's IPC bridge to work alongside the Vite dev server.
  clearScreen: false,
  server: {
    // Tauri's default dev-server port
    port: 1420,
    strictPort: true,
    // Allow LAN access so Capacitor Live Reload can reach the dev server.
    host: "0.0.0.0",
  },
  build: {
    // Tauri supports ES2021
    target: ["es2021", "chrome100", "safari13"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test-setup.js",
  },
});
