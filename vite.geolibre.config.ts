import { defineConfig } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // React's browser bundle checks process.env.NODE_ENV. GeoLibre imports the
  // plugin directly in the browser, where Node's process global is absent.
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
      // The GeoLibre package must expose the LST plugin declared in
      // geolibre-plugin/plugin.json, not the template demo entrypoint.
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
        // GeoLibre loads only the manifest entry; keep the plugin self-contained
        // so relative/dynamic chunk imports are not required.
        inlineDynamicImports: true,
      },
    },

    cssCodeSplit: false,
    sourcemap: false,
    minify: false,
  },
});
