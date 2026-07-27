// Flat ESLint configuration (ESLint 9+).
//
// Replaces the former .eslintrc.cjs. ESLint 9 defaults to this "flat config"
// format and ESLint 10 removes the old eslintrc format entirely, so the
// migration was required to move off end-of-life ESLint 8 (whose bundled
// minimatch 3.x pulled in the vulnerable brace-expansion <=5.0.7).
//
// Behaviour is intended to match the old .eslintrc.cjs one-for-one:
//   eslint:recommended + @typescript-eslint/recommended + react/recommended
//   + react-hooks/recommended + prettier (formatting rules off), with the
//   same handful of project-specific rule overrides.
//
// The TypeScript layer comes from the official `typescript-eslint` meta-package
// rather than wiring @typescript-eslint/{parser,eslint-plugin} by hand: its
// `configs.recommended` also applies the eslint-recommended overrides that turn
// off core rules TypeScript handles itself (e.g. no-undef, core no-unused-vars),
// which a hand-assembled config silently gets wrong.

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactPlugin from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  // Global ignores — flat config's replacement for .eslintrc ignorePatterns.
  // A config object with only `ignores` applies repo-wide. Build output and
  // any *.config.* file (this file, electron.vite.config.ts, etc.) are skipped,
  // matching the old ignorePatterns list.
  {
    ignores: ['**/dist/**', '**/out/**', '**/build/**', '**/node_modules/**', '**/*.config.*']
  },

  // eslint:recommended
  js.configs.recommended,

  // @typescript-eslint/recommended (+ the eslint-recommended core-rule overrides)
  ...tseslint.configs.recommended,

  // React, React Hooks, and the project-specific rule overrides, scoped to the
  // TypeScript/TSX sources the `lint` script actually targets.
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      // Old config used `env: { browser, es2020, node }`. Flat config has no
      // `env`; globals are supplied explicitly from the `globals` package.
      globals: { ...globals.browser, ...globals.node },
      parserOptions: {
        ecmaFeatures: { jsx: true }
      }
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks
    },
    settings: {
      react: { version: 'detect' }
    },
    rules: {
      // plugin:react/recommended
      ...reactPlugin.configs.recommended.rules,
      // plugin:react-hooks/recommended — pinned to the two rules directly rather
      // than spreading a config export, so this does not depend on the plugin's
      // (version-varying) config object shape.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // ── Project overrides (verbatim from the old .eslintrc.cjs) ──
      'react/react-in-jsx-scope': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      // Both env.d.ts triple-slash directives are standard electron-vite
      // boilerplate with no import equivalent.
      '@typescript-eslint/triple-slash-reference': 'off',
      // allowpopups is a valid Electron <webview> attribute, not standard HTML.
      'react/no-unknown-property': ['error', { ignore: ['allowpopups'] }]
    }
  },

  // Must come last: turns off every rule that would conflict with Prettier.
  prettier
)
