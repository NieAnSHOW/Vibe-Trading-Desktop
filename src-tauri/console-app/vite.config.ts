import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// 产物输出到 ../console-dist，Tauri frontendDist 不变即可加载。
// base: './' 保证 Tauri 内嵌时用相对路径加载 JS/CSS。
export default defineConfig({
  plugins: [vue()],
  base: "./",
  server: { port: 5173, strictPort: true },
  build: {
    outDir: "../console-dist",
    emptyOutDir: true,
    target: "es2020",
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
