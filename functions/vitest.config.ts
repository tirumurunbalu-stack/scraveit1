import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["**/node_modules/**", "**/lib/**"],
    coverage: {reporter: ["text", "json-summary"]},
  },
});
