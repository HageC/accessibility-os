import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/test-results/**",
      "**/next-env.d.ts",
      "**/AGENTS.md",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
