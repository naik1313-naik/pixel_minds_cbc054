import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: "forks",
    isolate: true,
    // Every test file calls resetDemo(), which truncates and reseeds the same
    // database. Running files in parallel therefore lets one file's reset delete
    // rows another file is halfway through asserting on — which produced
    // failures that passed in isolation and vanished on a re-run.
    //
    // Sequential is the honest configuration for a suite with a shared
    // mutable database. It costs wall-clock time and buys a result you can
    // believe: a green run means green.
    fileParallelism: false,
    sequence: { concurrent: false },
  },
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname) },
  },
});
