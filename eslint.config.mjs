// ESLint flat config. Formatting is Prettier's job (see .prettierrc.json);
// eslint-config-prettier switches off every rule that would argue with it.
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  { ignores: ["dist/", "node_modules/", "store/"] },

  js.configs.recommended,

  {
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-var": "error",
      "prefer-const": "error",
    },
  },

  // The extension: classic scripts that share a handful of globals, loaded in
  // order by the HTML pages (lib/*.js first, then the page's own script).
  {
    files: ["src/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        CookieUtils: "readonly",
        StorageUtils: "readonly",
        Api: "readonly",
        StorageView: "readonly",
      },
    },
  },

  {
    files: ["test/**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
  },

  {
    files: ["tools/**/*.mjs", "*.mjs"],
    languageOptions: { sourceType: "module", globals: globals.node },
  },

  prettier,
];
