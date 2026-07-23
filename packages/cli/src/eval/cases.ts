import type { EvalCase, EvalPromptProfile, EvalSuite } from './types.js';

export const EVAL_PROMPT_PROFILES: Readonly<Record<EvalPromptProfile, string>> = Object.freeze({
  baseline: `Use the DocBlocks MCP server for conversion and saving. Author Markdown and pass it directly to convert_document; no validation, inspection, preview, or authoring-context call is required. Do not create the Office artifact with shell commands or another document library. Return the exact Squisq-flavored Markdown supplied to the final convert_document call.`,
  'content-first': `Use the DocBlocks MCP server for the complete workflow. Author the complete Markdown first and pass it directly to convert_document. Squisq annotations are optional layout hints; use get_authoring_context only when exact examples help, and use inspection or preview only when the brief explicitly requires that evidence. Do not create the Office artifact with shell commands or another document library. Return the exact Squisq-flavored Markdown supplied to the final convert_document call.`,
});

export const MCP_CONTENT_EVAL_CASES: readonly EvalCase[] = Object.freeze([
  {
    id: 'quarterly-product-review-pptx',
    title: 'Quarterly product review deck',
    suites: ['quick', 'full'],
    targetFormat: 'pptx',
    artifactFilename: 'quarterly-product-review.pptx',
    brief: `Create an executive-ready quarterly product review presentation for Northstar, a fictional B2B workflow product. The audience is the leadership team. Use 8 slides and make the story decision-oriented, not a data dump.

Use these facts exactly:
- Q2 active teams: 18,420, up 14% quarter over quarter.
- Weekly retained teams: 71%, up from 66% in Q1.
- Enterprise expansion revenue: $3.8M, 92% of the $4.1M target.
- Activation improved from 42% to 49% after guided setup shipped.
- Mobile weekly usage is 23%, below the 30% goal.
- Top support driver is permissions setup, representing 31% of tickets.
- The proposed Q3 choices are: fund permissions redesign, protect activation gains, and defer advanced mobile editing.

Include a clear opening thesis, a compact scorecard, insights rather than repeated metrics, the three Q3 choices with tradeoffs, and a final decision/owner slide.`,
    rubric: [
      'Builds a coherent executive narrative from performance to causes to decisions.',
      'Preserves every supplied metric and does not invent unsupported business facts.',
      'Makes the three Q3 choices, tradeoffs, owners, and decisions easy to scan.',
      'Uses slide-appropriate density and varied Squisq templates without sacrificing content.',
    ],
    expectation: {
      minItems: 8,
      maxItems: 8,
      minWords: 220,
      maxWords: 650,
      maxWordsPerSection: 95,
      minVisualTemplates: 2,
      requiredPhrases: ['18,420', '71%', '$3.8M', '49%', '23%', '31%', 'permissions'],
    },
  },
  {
    id: 'responsible-ai-training-pptx',
    title: 'Responsible AI manager training deck',
    suites: ['full'],
    targetFormat: 'pptx',
    artifactFilename: 'responsible-ai-training.pptx',
    brief: `Create a 9-slide manager training presentation called "Responsible AI in Everyday Work." The audience is nontechnical people managers. Teach a usable decision process, not generic inspiration.

Cover: a plain-language definition, an opening scenario, a four-question risk screen, examples of acceptable and unacceptable use, handling confidential data, reviewing model output, escalation triggers, a short practice scenario with answer, and a final one-week action plan. State clearly that humans remain accountable for decisions and that confidential customer or employee data must not be pasted into unapproved tools.`,
    rubric: [
      'Uses plain language and a practical teaching progression.',
      'Contains an actionable four-question screen and realistic examples.',
      'Makes confidentiality, human accountability, and escalation memorable.',
      'Fits a live training deck with concise slides and useful visual variation.',
    ],
    expectation: {
      minItems: 9,
      maxItems: 9,
      minWords: 240,
      maxWords: 700,
      maxWordsPerSection: 90,
      minVisualTemplates: 2,
      requiredPhrases: ['accountable', 'confidential', 'escalat', 'four', 'one-week'],
    },
  },
  {
    id: 'build-vs-buy-decision-memo-docx',
    title: 'Build-versus-buy decision memo',
    suites: ['quick', 'full'],
    targetFormat: 'docx',
    artifactFilename: 'build-vs-buy-decision-memo.docx',
    brief: `Write a professional decision memo for the COO recommending whether a fictional 420-person company should build or buy a contract-lifecycle-management system.

Use these facts exactly:
- Current manual work costs about 1,900 staff hours per quarter.
- A vendor solution costs $310,000 in year one and $190,000 annually afterward.
- An internal build is estimated at 8 engineer-months plus 2 ongoing engineer-months per year.
- Security review found no blocking issue for the vendor, but data residency needs a contractual addendum.
- Procurement can complete negotiation in six weeks.
- The operations team needs the first workflow live within ten weeks.

Recommend one path, explain the decision criteria and quantified tradeoffs, name risks and mitigations, give an implementation sequence, and end with the exact decision requested from the COO. Aim for roughly 1,000-1,400 words.`,
    rubric: [
      'Makes a clear recommendation supported by the supplied time, cost, and delivery facts.',
      'Separates facts, assumptions, risks, mitigations, and decision request.',
      'Provides a credible implementation sequence and accountable next steps.',
      'Reads as an executive memo rather than a slide deck pasted into Word.',
    ],
    expectation: {
      minItems: 6,
      maxItems: 14,
      minWords: 850,
      maxWords: 1_550,
      maxWordsPerSection: 360,
      minVisualTemplates: 0,
      requiredPhrases: [
        '1,900',
        '$310,000',
        '$190,000',
        '8 engineer-months',
        'six weeks',
        'ten weeks',
      ],
    },
  },
  {
    id: 'incident-response-playbook-docx',
    title: 'Incident response playbook',
    suites: ['full'],
    targetFormat: 'docx',
    artifactFilename: 'incident-response-playbook.docx',
    brief: `Create a concise operational playbook for responding to a suspected customer-data exposure at a SaaS company. It must be usable during an incident.

Include: purpose and scope, severity triggers, the first 15/30/60 minutes, roles for incident commander/security/legal/support, an evidence-preservation checklist, communication rules, a decision log template, containment and recovery gates, customer-notification decision criteria, and a post-incident checklist. Explicitly say not to delete or alter evidence and not to make unverified claims to customers. Use tables or checklists where they improve scanability. Aim for 1,200-1,800 words.`,
    rubric: [
      'Works as an executable playbook under time pressure.',
      'Distinguishes containment, investigation, recovery, and communication decisions.',
      'Protects evidence and prevents unverified external statements.',
      'Uses document-native structure, tables, and checklists for rapid scanning.',
    ],
    expectation: {
      minItems: 8,
      maxItems: 20,
      minWords: 1_000,
      maxWords: 2_000,
      maxWordsPerSection: 400,
      minVisualTemplates: 0,
      requiredPhrases: ['15', '30', '60', 'incident commander', 'evidence', 'unverified'],
    },
  },
]);

export function selectEvalCases(suiteOrIds: string): readonly EvalCase[] {
  if (suiteOrIds === 'quick' || suiteOrIds === 'full') {
    const suite: EvalSuite = suiteOrIds;
    return MCP_CONTENT_EVAL_CASES.filter((testCase) => testCase.suites.includes(suite));
  }
  const ids = new Set(
    suiteOrIds
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if (ids.size === 0) throw new Error('At least one eval case id is required');
  const selected = MCP_CONTENT_EVAL_CASES.filter((testCase) => ids.has(testCase.id));
  const missing = [...ids].filter((id) => !selected.some((testCase) => testCase.id === id));
  if (missing.length > 0) throw new Error(`Unknown eval case ids: ${missing.join(', ')}`);
  return selected;
}
