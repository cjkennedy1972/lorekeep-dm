import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import jsxA11y from 'eslint-plugin-jsx-a11y';
const boundaries = [
  {
    patterns: [
      {
        group: ['**/apps/**', '@game/server', '@game/web'],
        message: 'Packages cannot import apps.',
      },
    ],
  },
];
export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  {
    files: ['apps/server/migrations/**/*.js'],
    languageOptions: { globals: { URL: 'readonly' } },
  },
  ...tseslint.configs.recommended,
  {
    files: ['packages/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', ...boundaries] },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'jsx-a11y': jsxA11y },
    rules: {
      ...jsxA11y.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/server/**', '@game/server'],
              message: 'Web cannot import server.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/server/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/apps/web/**', '@game/web'],
              message: 'Server cannot import web.',
            },
          ],
        },
      ],
    },
  },
];
