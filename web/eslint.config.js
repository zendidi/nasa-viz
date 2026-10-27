// Correctness only, no style: this exists to catch what `vite build` and Vitest
// both let through — a name left behind when code moves between modules, which
// only fails as a ReferenceError at runtime (docs/agent/decisions.md, « Découpage
// de `main.js` »). Don't add formatting rules here, and don't silence a finding
// with a disable comment: like PHPStan, zero means zero.
import globals from 'globals'

export default [
  { ignores: ['dist/', 'node_modules/'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-undef': 'error',
      // `const { key, ...rest } = obj` is how a key is dropped; `key` is unused by design.
      'no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  { files: ['src/**/*.js'], languageOptions: { globals: globals.browser } },
  { files: ['tests/**/*.js', '*.config.js'], languageOptions: { globals: globals.node } },
]
