import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // An effect's return value is its cleanup: an expression-bodied arrow returns whatever the call returns.
      // `() => window.scrollTo(0, 0)` returned a Promise in newer Chrome and broke every in-app navigation (#86).
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.name=/^use(Layout|Insertion)?Effect$/] > ArrowFunctionExpression:first-child[body.type!='BlockStatement']",
          message: "Use a block body in effects: an expression-bodied arrow returns its value as the effect's cleanup.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    // Vite web build output (spec 013, 4.1).
    "dist/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
