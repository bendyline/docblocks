import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { countWords, summarizeChecks } from './markdown-judge.js';
import type { EvalCase, EvalCheck, StaticJudgeResult } from './types.js';

export async function judgeArtifact(
  artifactPath: string,
  testCase: EvalCase,
): Promise<StaticJudgeResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(artifactPath);
  } catch (caught: unknown) {
    return missingArtifact(caught);
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch (caught: unknown) {
    const message = caught instanceof Error ? caught.message : String(caught);
    return summarizeChecks(
      [
        {
          id: 'valid-zip',
          passed: false,
          required: true,
          message: `Office artifact is not a valid ZIP package: ${message}`,
          observed: false,
          expected: true,
        },
      ],
      { byteSize: bytes.byteLength },
    );
  }

  return testCase.targetFormat === 'pptx'
    ? judgePptx(zip, bytes.byteLength, testCase)
    : judgeDocx(zip, bytes.byteLength, testCase);
}

async function judgePptx(
  zip: JSZip,
  byteSize: number,
  testCase: EvalCase,
): Promise<StaticJudgeResult> {
  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort(numericOfficePartSort);
  const slideTexts = await Promise.all(
    slidePaths.map(async (path) => extractXmlText(await requiredZipText(zip, path), 'a:t')),
  );
  const emptySlides = slideTexts.filter((text) => countWords(text) < 2).length;
  const overfullSlides = slideTexts.filter((text) => countWords(text) > 120).length;
  const allText = slideTexts.join(' ');
  const checks: EvalCheck[] = [
    packagePartCheck(zip, '[Content_Types].xml'),
    packagePartCheck(zip, 'ppt/presentation.xml'),
    packagePartCheck(zip, 'ppt/_rels/presentation.xml.rels'),
    rangeCheck(
      'slide-count',
      slidePaths.length,
      testCase.expectation.minItems,
      testCase.expectation.maxItems,
    ),
    {
      id: 'nonempty-slides',
      passed: emptySlides === 0,
      required: true,
      message: `${emptySlides} slides contain fewer than two extractable words`,
      observed: emptySlides,
      expected: 0,
    },
    {
      id: 'slide-density',
      passed: overfullSlides === 0,
      required: false,
      message: `${overfullSlides} slides contain more than 120 extractable words`,
      observed: overfullSlides,
      expected: 0,
    },
    {
      id: 'theme-part',
      passed: Object.keys(zip.files).some((name) => /^ppt\/theme\/theme\d+\.xml$/.test(name)),
      required: true,
      message: 'Presentation contains an Office theme part',
      observed: Object.keys(zip.files).some((name) => /^ppt\/theme\/theme\d+\.xml$/.test(name)),
      expected: true,
    },
  ];
  return summarizeChecks(checks, {
    byteSize,
    packageEntries: Object.keys(zip.files).length,
    slideCount: slidePaths.length,
    emptySlides,
    overfullSlides,
    extractableWordCount: countWords(allText),
  });
}

async function judgeDocx(
  zip: JSZip,
  byteSize: number,
  testCase: EvalCase,
): Promise<StaticJudgeResult> {
  const documentXml = await optionalZipText(zip, 'word/document.xml');
  const text = documentXml ? extractXmlText(documentXml, 'w:t') : '';
  const paragraphCount = documentXml?.match(/<w:p(?:\s|>)/g)?.length ?? 0;
  const headingCount = documentXml?.match(/<w:pStyle\s+[^>]*w:val="Heading[1-9]"/g)?.length ?? 0;
  const tableCount = documentXml?.match(/<w:tbl(?:\s|>)/g)?.length ?? 0;
  const checks: EvalCheck[] = [
    packagePartCheck(zip, '[Content_Types].xml'),
    packagePartCheck(zip, 'word/document.xml'),
    packagePartCheck(zip, 'word/styles.xml'),
    {
      id: 'extractable-content',
      passed: countWords(text) >= Math.round(testCase.expectation.minWords * 0.75),
      required: true,
      message: `DOCX contains ${countWords(text)} extractable words`,
      observed: countWords(text),
      expected: `>=${Math.round(testCase.expectation.minWords * 0.75)}`,
    },
    {
      id: 'paragraph-structure',
      passed: paragraphCount >= testCase.expectation.minItems,
      required: true,
      message: `DOCX contains ${paragraphCount} paragraphs`,
      observed: paragraphCount,
      expected: `>=${testCase.expectation.minItems}`,
    },
    {
      id: 'heading-structure',
      passed: headingCount >= Math.min(3, testCase.expectation.minItems),
      required: false,
      message: `DOCX contains ${headingCount} native heading-style paragraphs`,
      observed: headingCount,
      expected: `>=${Math.min(3, testCase.expectation.minItems)}`,
    },
  ];
  return summarizeChecks(checks, {
    byteSize,
    packageEntries: Object.keys(zip.files).length,
    extractableWordCount: countWords(text),
    paragraphCount,
    headingCount,
    tableCount,
  });
}

function packagePartCheck(zip: JSZip, path: string): EvalCheck {
  const present = Boolean(zip.file(path));
  return {
    id: `package-part:${path}`,
    passed: present,
    required: true,
    message: `${path} is ${present ? 'present' : 'missing'}`,
    observed: present,
    expected: true,
  };
}

function rangeCheck(id: string, observed: number, minimum: number, maximum: number): EvalCheck {
  return {
    id,
    passed: observed >= minimum && observed <= maximum,
    required: true,
    message: `${id}: ${observed}; expected ${minimum}-${maximum}`,
    observed,
    expected: `${minimum}-${maximum}`,
  };
}

function numericOfficePartSort(left: string, right: string): number {
  return Number(left.match(/(\d+)\.xml$/)?.[1] ?? 0) - Number(right.match(/(\d+)\.xml$/)?.[1] ?? 0);
}

function extractXmlText(xml: string, tagName: string): string {
  const escaped = tagName.replace(':', '\\:');
  const matches = xml.matchAll(
    new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'g'),
  );
  return [...matches]
    .map((match) => decodeXml(match[1]))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

async function requiredZipText(zip: JSZip, path: string): Promise<string> {
  const value = await optionalZipText(zip, path);
  if (value === null) throw new Error(`Missing Office package part: ${path}`);
  return value;
}

async function optionalZipText(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path);
  return file ? file.async('string') : null;
}

function missingArtifact(caught: unknown): StaticJudgeResult {
  const message = caught instanceof Error ? caught.message : String(caught);
  return summarizeChecks(
    [
      {
        id: 'artifact-exists',
        passed: false,
        required: true,
        message: `Artifact could not be read: ${message}`,
        observed: false,
        expected: true,
      },
    ],
    { byteSize: 0 },
  );
}
