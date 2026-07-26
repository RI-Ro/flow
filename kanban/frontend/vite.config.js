import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // ВАЖНО: /api/ws объявлен ПЕРВЫМ. Vite выбирает первое совпадение
      // по префиксу, и правило "/api" перехватывало также "/api/ws",
      // отправляя его в обычный http-прокси без апгрейда соединения —
      // из-за этого WebSocket не поднимался вообще, и вся синхронизация
      // в реальном времени молча не работала.
      "/api/ws": { target: "ws://localhost:8080", ws: true, changeOrigin: true },
      "/api": { target: "http://localhost:8080", changeOrigin: true },
      // WebSocket проксируется отдельно: обычный http-прокси не делает
      // апгрейд соединения сам по себе.
      "/api/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
