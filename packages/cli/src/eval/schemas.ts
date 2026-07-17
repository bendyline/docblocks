import type { EvalCase } from './types.js';

export function generationOutputSchema(testCase: EvalCase): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      artifactPath: { type: 'string', const: testCase.artifactFilename },
      targetFormat: { type: 'string', const: testCase.targetFormat },
      fidelity: { type: 'string', minLength: 1, maxLength: 64 },
      markdown: { type: 'string', minLength: 1, maxLength: 500_000 },
      summary: { type: 'string', minLength: 1, maxLength: 2_000 },
      validationRepairs: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 1_000 },
        maxItems: 50,
      },
    },
    required: [
      'artifactPath',
      'targetFormat',
      'fidelity',
      'markdown',
      'summary',
      'validationRepairs',
    ],
    additionalProperties: false,
  };
}

export const LLM_JUDGE_OUTPUT_SCHEMA: Record<string, unknown> = Object.freeze({
  type: 'object',
  properties: {
    scores: {
      type: 'object',
      properties: {
        briefAdherence: { type: 'integer', minimum: 1, maximum: 5 },
        contentQuality: { type: 'integer', minimum: 1, maximum: 5 },
        structure: { type: 'integer', minimum: 1, maximum: 5 },
        formatFitness: { type: 'integer', minimum: 1, maximum: 5 },
        squisqUsage: { type: 'integer', minimum: 1, maximum: 5 },
        overall: { type: 'integer', minimum: 1, maximum: 5 },
      },
      required: [
        'briefAdherence',
        'contentQuality',
        'structure',
        'formatFitness',
        'squisqUsage',
        'overall',
      ],
      additionalProperties: false,
    },
    strengths: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 1_000 },
      minItems: 1,
      maxItems: 8,
    },
    weaknesses: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 1_000 },
      minItems: 1,
      maxItems: 8,
    },
    unsupportedClaims: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 1_000 },
      maxItems: 12,
    },
    missingRequestedElements: {
      type: 'array',
      items: { type: 'string', minLength: 1, maxLength: 1_000 },
      maxItems: 12,
    },
    recommendation: { type: 'string', minLength: 1, maxLength: 2_000 },
  },
  required: [
    'scores',
    'strengths',
    'weaknesses',
    'unsupportedClaims',
    'missingRequestedElements',
    'recommendation',
  ],
  additionalProperties: false,
});
