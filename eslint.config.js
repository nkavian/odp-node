import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "**/.turbo/**"]
  },
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["packages/**/src/**/*.ts", "packages/**/test/**/*.ts", "examples/**/src/**/*.ts"],
    languageOptions: {
      ...config.languageOptions,
      parserOptions: {
        ...config.languageOptions?.parserOptions,
        project: ["./packages/*/tsconfig.test.json", "./examples/*/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname
      }
    }
  })),
  {
    files: ["packages/**/src/**/*.ts", "examples/**/src/**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" }
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "no-console": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@offering-protocol/*/src", "@offering-protocol/*/src/*"],
              message: "Import from the package public API."
            }
          ]
        }
      ]
    }
  },
  prettier
);
