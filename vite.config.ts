import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// base relativa: el build funciona igual en GitHub Pages que abriendo dist/ desde cualquier carpeta.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { chunkSizeWarningLimit: 1200 }, // three.js pesa ~600 kB; es esperado
});
