import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Project-wide rules. `no-console` is not part of the recommended set, so we
    // enable it explicitly here — that is what gives the inline
    // `eslint-disable-next-line no-console` directives their meaning.
    rules: {
      "no-console": "error",
    },
  },
  {
    // Browser code.
    files: ["frontend/src/**/*.ts"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // Node code: server, build scripts, tests, shared.
    files: ["mock-server/src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts", "shared/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Vitest globals for the test suite.
    files: ["tests/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
);
