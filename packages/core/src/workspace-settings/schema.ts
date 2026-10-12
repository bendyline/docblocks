/**
 * JSON Schema (draft-07) for `.docblocks/workspace.json`, used for editor
 * validation and completion (VS Code `contributes.jsonValidation`). The
 * runtime parser in `settings.ts` remains the authority; tests keep the two
 * aligned.
 */

import {
  CATALOG_JSON_CONTENT_MODES,
  CATALOG_SORT_ORDERS,
  DEFAULT_CATALOG_HTML_PATH,
  DEFAULT_CATALOG_JSON_PATH,
  DEFAULT_CATALOG_TITLE,
  WORKSPACE_SETTINGS_LIMITS,
  WORKSPACE_THEME_ID_PATTERN,
} from './settings.js';

const themeId = {
  type: 'string',
  pattern: WORKSPACE_THEME_ID_PATTERN.source,
  description: 'A DocBlocks document theme id, such as "warm-earth".',
} as const;

const relativePath = {
  type: 'string',
  minLength: 1,
  maxLength: WORKSPACE_SETTINGS_LIMITS.maxPathCharacters,
} as const;

export const WORKSPACE_SETTINGS_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'DocBlocks workspace settings',
  description:
    'Settings shared by everyone who opens this folder in DocBlocks. Every section is optional.',
  type: 'object',
  additionalProperties: false,
  required: ['version'],
  properties: {
    $schema: { type: 'string', maxLength: WORKSPACE_SETTINGS_LIMITS.maxSchemaCharacters },
    version: { const: 1, description: 'Settings format version.' },
    documents: {
      type: 'object',
      additionalProperties: false,
      properties: {
        defaultTheme: {
          ...themeId,
          description:
            'Theme for documents whose frontmatter does not name one. A document’s own theme always wins.',
        },
      },
    },
    versionHistory: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: {
          type: 'boolean',
          description:
            'Keep prior revisions for documents in this folder. Omit to use the app default.',
        },
        keep: {
          type: 'integer',
          minimum: WORKSPACE_SETTINGS_LIMITS.minKeep,
          maximum: WORKSPACE_SETTINGS_LIMITS.maxKeep,
          description: 'Revisions kept per document.',
        },
      },
    },
    catalog: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: {
          type: 'string',
          minLength: 1,
          maxLength: WORKSPACE_SETTINGS_LIMITS.maxTitleCharacters,
          description: `Catalog heading. Defaults to "${DEFAULT_CATALOG_TITLE}".`,
        },
        sort: {
          enum: [...CATALOG_SORT_ORDERS],
          description: 'Catalog order. Defaults to "title".',
        },
        exclude: {
          type: 'array',
          maxItems: WORKSPACE_SETTINGS_LIMITS.maxExcludes,
          items: relativePath,
          description: 'Workspace-relative folders or files left out of the catalog.',
        },
        html: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', description: 'Regenerate the catalog page on every save.' },
            path: {
              ...relativePath,
              pattern: '\\.html?$',
              description: `Catalog page path. Defaults to "${DEFAULT_CATALOG_HTML_PATH}".`,
            },
            theme: { ...themeId, description: 'Theme for the catalog page only.' },
          },
        },
        json: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', description: 'Regenerate the catalog data on every save.' },
            path: {
              ...relativePath,
              pattern: '\\.json$',
              description: `Catalog data path. Defaults to "${DEFAULT_CATALOG_JSON_PATH}".`,
            },
            content: {
              enum: [...CATALOG_JSON_CONTENT_MODES],
              description: '"metadata" (default) or "markdown" to include each document’s source.',
            },
          },
        },
      },
    },
  },
} as const;
