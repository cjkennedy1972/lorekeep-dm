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
  {
    // M2-19: outbound LLM traffic must go through the egress guard.
    files: ['apps/server/src/llm/**/*.ts'],
    ignores: ['apps/server/src/llm/egress.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use the egress guard (llm/egress.ts).' },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            'node:http',
            'node:https',
            'node:net',
            'node:tls',
            'http',
            'https',
            'undici',
          ].map((name) => ({
            name,
            message: 'Use the egress guard (llm/egress.ts).',
          })),
        },
      ],
    },
  },
];
