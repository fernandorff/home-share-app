import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import react from "eslint-plugin-react";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default defineConfig([
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    // The React and accessibility rules eslint-config-next turned on, at the same levels.
    plugins: { react, "jsx-a11y": jsxA11y },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.recommended.rules,
      "react/no-unknown-property": "off",
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "react/jsx-no-target-blank": "off",
      "jsx-a11y/alt-text": ["warn", { elements: ["img"] }],
      "jsx-a11y/aria-props": "warn",
      "jsx-a11y/aria-proptypes": "warn",
      "jsx-a11y/aria-unsupported-elements": "warn",
      "jsx-a11y/role-has-required-aria-props": "warn",
      "jsx-a11y/role-supports-aria-props": "warn",
    },
  },
  {
    rules: {
      // Same levels eslint-config-next used (it set these two to warn).
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
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
  globalIgnores(["dist/**", "server/target/**", "src/generated/**"]),
]);
