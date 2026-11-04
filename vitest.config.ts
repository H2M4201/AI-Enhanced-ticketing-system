import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts?(x)"],
    // PGlite setup is slow on this machine, and the suite runs files in parallel, so 5s is too tight.
    testTimeout: 20_000,
  },
});
