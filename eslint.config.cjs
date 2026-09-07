const eslint = require("@eslint/js");
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir: __dirname,
      },
    },
  },
  {
    rules: {
      // --- already-passing rules (mechanical fixes from previous pass) ---
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],

      // --- rules with hits: require a fix pass ---
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/promise-function-async": "error",
      "@typescript-eslint/strict-void-return": "error",
      "@typescript-eslint/no-loop-func": "error",

      // --- zero-hit rules: future protection ---
      "@typescript-eslint/consistent-type-exports": ["error", { fixMixedExportsWithInlineTypeSpecifier: true }],
      "@typescript-eslint/default-param-last": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-dupe-class-members": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-invalid-this": "error",
      "@typescript-eslint/no-loss-of-precision": "error",
      "@typescript-eslint/no-redeclare": "error",
      "@typescript-eslint/no-shadow": "error",
      "@typescript-eslint/no-unnecessary-parameter-property-assignment": "error",
      "@typescript-eslint/no-unnecessary-qualifier": "error",
      "@typescript-eslint/no-unused-private-class-members": "error",
      "@typescript-eslint/no-useless-empty-export": "error",
      "@typescript-eslint/no-var-requires": "error",
      "@typescript-eslint/prefer-enum-initializers": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/prefer-ts-expect-error": "error",
      "@typescript-eslint/require-array-sort-compare": ["error", { ignoreStringArrays: true }],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "data/", "claudisms/", ".opencode/", "webapp/svelte.config.js", "webapp/wasm-pkg/"],
  },
);
