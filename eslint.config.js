// @ts-check
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['test/golden/**', 'node_modules/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Steps deliberately use `any` at network-boundary types (FetchLike's
      // json()/text() return shapes) — recommended already flags unsafe
      // uses of it elsewhere, so a blanket ban isn't worth the churn here.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
