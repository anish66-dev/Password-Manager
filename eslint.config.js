import js from "@eslint/js";
import tsPlugin from "typescript-eslint";

export default tsPlugin.config(
  js.configs.recommended,
  ...tsPlugin.configs.recommended,
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/.vite/**", "doc/**"],
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-module-boundary-types": "off",
    },
  },
  {
    files: ["shared/src/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        "window",
        "document",
        "chrome",
        "navigator",
        "localStorage",
        "sessionStorage",
        "indexedDB",
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["chrome", "react", "react-dom", "react-dom/*"],
              message: "shared/ code must never import Chrome, React, or the DOM.",
            },
          ],
        },
      ],
    },
  }
);
