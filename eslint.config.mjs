import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";

export default [
  {
    files: ["**/*.{js,mjs,cjs,ts}"],
    languageOptions: {
      globals: globals.browser,
    },
    ...pluginJs.configs.recommended,
    ...tseslint.configs.recommended,
    rules: {
      "prettier/prettier": "error",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];