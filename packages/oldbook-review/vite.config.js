import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    rollupOptions: { input: {
      reader: fileURLToPath(new URL("./index.html", import.meta.url)),
      editor: fileURLToPath(new URL("./editor.html", import.meta.url))
    } }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3100",
      "/data": "http://127.0.0.1:3100"
    }
  }
});
