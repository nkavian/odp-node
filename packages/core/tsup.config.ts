import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  noExternal: [/^ajv(?:-formats)?(?:\/|$)/],
  clean: true
});
