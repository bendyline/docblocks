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
    'Renderer code must never import electron. Use getDocBlocksHost() from @bendyline/docblocks/host and degrade gracefully where a capability is absent.',
};

/**
 * `isElectronHost()` was a single boolean standing in for a dozen unrelated
 * decisions — filesystem backend, export destinations, menu commands, window
 * chrome, storage warnings — and no non-Electron host can answer it honestly
 * either way. Ask what the host can DO instead. Identity questions that are
 * genuinely about the product (a documentation URL, say) read
 * `getHostEnvironment()?.surface` and say so at the call site.
 */
const HOST_CAPABILITY_RESTRICTION = {
  name: '@bendyline/docblocks/host',
  importNames: ['isElectronHost'],
  message:
    'Ask a capability instead: hostSupports(...), hasDocBlocksHost(), or getHostEnvironment().',
};

function browserContextImportRule(extraPaths = []) {
  return [
    'error',
    {
      paths: [
        ELECTRON_IMPORT_RESTRICTION,
        HOST_CAPABILITY_RESTRICTION,
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
      '**/reports/**',
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

  // Shared UI is mounted by every surface, so it must never branch on which
  // shell it is running in. NOTE: renderer surfaces get this same restriction
  // through browserContextImportRule() rather than a second block here — a
  // flat-config block REPLACES rule options for overlapping files rather than
  // merging them, so a separate block would silently drop their electron and
  // node: import bans.
  {
    files: ['packages/react/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [HOST_CAPABILITY_RESTRICTION] }],
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
