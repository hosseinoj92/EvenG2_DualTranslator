// Flat ESLint config shared by every workspace.
// Non-type-checked rule sets are used on purpose: they keep `npm run lint` fast
// and independent of per-package tsconfig project references.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/.wrangler/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Interop with the Even Hub SDK and Workers AI requires narrowing `unknown`
      // payloads; `any` stays banned so that narrowing is always explicit.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
    },
  },
  prettier,
);
