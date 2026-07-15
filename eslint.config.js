import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// Renderer surfaces run in a browser context and reach privileged capability
// only through the two seams: FileSystemProvider for user documents, and
// DocBlocksHostAPI (`getDocBlocksHost()`) for everything Electron exposes.
// Reaching for `electron` or a Node builtin directly breaks the build for the
// web surfaces and the security model for the desktop one, so these are the
// "hard rules" from AGENTS.md expressed as lint rather than as prose.
const NODE_BUILTIN_IMPORT_PATTERNS = [
  {
    group: ['node:*'],
    message:
      'Renderer code runs in a browser context. Use the FileSystemProvider seam or getDocBlocksHost() from @bendyline/docblocks/host.',
  },
];

const NODE_BUILTIN_BARE_IMPORTS = [
  'fs',
  'fs/promises',
  'path',
  'os',
  'child_process',
  'worker_threads',
  'module',
];

const ELECTRON_IMPORT_RESTRICTION = {
  name: 'electron',
  message:
    'Renderer code must never import electron. Use getDocBlocksHost() / isElectronHost() from @bendyline/docblocks/host and degrade gracefully off-Electron.',
};

function browserContextImportRule(extraPaths = []) {
  return [
    'error',
    {
      paths: [
        ELECTRON_IMPORT_RESTRICTION,
        ...NODE_BUILTIN_BARE_IMPORTS.map((name) => ({
          name,
          message:
            'Renderer code runs in a browser context. Use the FileSystemProvider seam or getDocBlocksHost() from @bendyline/docblocks/host.',
        })),
        ...extraPaths,
      ],
      patterns: NODE_BUILTIN_IMPORT_PATTERNS,
    },
  ];
}

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.config.ts',
      '**/*.config.js',
      '**/vitest.setup.ts',
      // Both hold a downloaded VS Code distribution, not our source. Linting
      // the desktop archive alone reports ~37k errors from workbench bundles
      // and exhausts the default heap before eslint can finish.
      '**/.vscode-test-web/**',
      '**/.vscode-test/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript recommended
  ...tseslint.configs.recommended,

  // React hooks rules for react & site packages
  {
    files: [
      'packages/react/**/*.{ts,tsx}',
      'packages/site/**/*.{ts,tsx}',
      'packages/vscode/webview/**/*.{ts,tsx}',
    ],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // Project-wide rule overrides
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // Renderer = site + desktop renderer. Browser context; no electron, no node:*.
  {
    files: ['packages/desktop/renderer/**/*.{ts,tsx}', 'packages/site/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': browserContextImportRule(),
    },
  },

  // The VS Code webview is a sandboxed browser context on the far side of a
  // postMessage boundary: it additionally must never import `vscode` itself.
  // The only host contract is the discriminated union in core.
  {
    files: ['packages/vscode/webview/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': browserContextImportRule([
        {
          name: 'vscode',
          message:
            'The webview is a sandboxed browser context. Cross the boundary with the postMessage messages in @bendyline/docblocks/vscode instead.',
        },
      ]),
    },
  },

  // Test file relaxations
  {
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
    },
  },

  // CommonJS scripts (electron-builder hooks) run in Node with require().
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      'no-console': 'off',
    },
  },

  // Electron main and preload run in Node.
  {
    files: ['packages/desktop/main/**/*.ts', 'packages/desktop/preload/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Disable rules that conflict with Prettier (must be last)
  prettier,
);
