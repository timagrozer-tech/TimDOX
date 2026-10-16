import { defineConfig } from "vite";

// Сборка в одну папку dist с относительными путями: её можно выложить в любую папку сайта (REG.RU и т. п.)
export default defineConfig({
  base: "./",
  build: { target: "es2020", outDir: "dist", assetsInlineLimit: 0, sourcemap: false },
  worker: { format: "es" },
});
