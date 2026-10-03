import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // O plugin roda diretamente no navegador dentro do GeoLibre.
  // Substitui process.env.NODE_ENV, que não existe no navegador.
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },

  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },

  build: {
    lib: {
      // Entry point real do plugin LST Super-Resolution.
      entry: resolve(__dirname, "src/main.tsx"),
      formats: ["es"],
      fileName: () => "index.js",
    },

    // Pasta criada automaticamente durante o build.
    outDir: "geolibre-plugin/dist",
    emptyOutDir: true,

    rollupOptions: {
      // As dependências precisam ser incluídas no bundle.
      external: [],

      output: {
        assetFileNames: () => "style.css",

        // O instalador web do GeoLibre carrega apenas o index.js
        // indicado no plugin.json.
        inlineDynamicImports: true,
      },
    },

    cssCodeSplit: false,
    sourcemap: false,
    minify: false,
  },
});
