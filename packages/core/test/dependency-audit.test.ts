import { expect } from 'chai';
import {
  evaluateAudit,
  normalizeAuditReport,
  parseDispositionDocument,
} from '../../../scripts/check-dependency-audit.js';

const auditReport = {
  auditReportVersion: 2,
  vulnerabilities: {
    vulnerable: {
      name: 'vulnerable',
      severity: 'high',
      isDirect: false,
      via: [
        {
          source: 123,
          name: 'vulnerable',
          dependency: 'vulnerable',
          title: 'Synthetic advisory',
          url: 'https://github.com/advisories/GHSA-AAAA-BBBB-CCCC',
          severity: 'high',
          cwe: ['CWE-1'],
          cvss: { score: 8, vectorString: null },
          range: '<2.0.0',
        },
      ],
      effects: ['consumer'],
      range: '<2.0.0',
      nodes: ['node_modules/vulnerable'],
      fixAvailable: true,
    },
    consumer: {
      name: 'consumer',
      severity: 'high',
      isDirect: true,
      via: ['vulnerable'],
      effects: [],
      range: '*',
      nodes: ['node_modules/consumer'],
      fixAvailable: true,
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 },
  },
} as const;

function disposition(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    schemaVersion: 1,
    reviewedAt: '2026-09-07',
    dispositions: [
      {
        package: 'vulnerable',
        advisory: 'GHSA-AAAA-BBBB-CCCC',
        severity: 'high',
        scope: 'development-only',
        classification: 'not-shipped',
        owner: 'Test maintainers',
        expires: '2026-09-21',
        reason: 'This synthetic finding exists only in a test dependency and is not shipped.',
        remediation:
          'Update the synthetic dependency as soon as its patched release becomes eligible.',
        ...overrides,
      },
    ],
  };
}

describe('dependency audit policy', () => {
  it('normalizes advisory objects without duplicating dependency fan-out strings', () => {
    const result = normalizeAuditReport(auditReport);
    expect(result.findings).to.have.length(1);
    expect(result.findings[0]).to.include({
      package: 'vulnerable',
      advisory: 'GHSA-AAAA-BBBB-CCCC',
      severity: 'high',
    });
    expect(result.summary.total).to.equal(2);
  });

  it('accepts a current disposition for a non-shipped finding', () => {
    expect(evaluateAudit(auditReport, disposition(), '2026-09-07').failures).to.deep.equal([]);
  });

  it('fails closed for missing, stale, expired, severity-drifted, and shipped high findings', () => {
    const missing = { schemaVersion: 1, reviewedAt: '2026-09-07', dispositions: [] };
    expect(evaluateAudit(auditReport, missing, '2026-09-07').failures).to.include(
      'missing disposition for vulnerable GHSA-AAAA-BBBB-CCCC',
    );
    expect(evaluateAudit(auditReport, disposition(), '2026-09-21').failures.join('\n')).to.include(
      'expired',
    );
    expect(
      evaluateAudit(auditReport, disposition({ severity: 'moderate' }), '2026-09-07').failures.join(
        '\n',
      ),
    ).to.include('severity drift');
    expect(
      evaluateAudit(auditReport, disposition({ scope: 'shipped' }), '2026-09-07').failures.join(
        '\n',
      ),
    ).to.include('cannot be dispositioned');

    const noFindings = {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      },
    };
    expect(evaluateAudit(noFindings, disposition(), '2026-09-07').failures.join('\n')).to.include(
      'stale disposition',
    );
  });

  it('rejects unknown disposition fields', () => {
    expect(() => parseDispositionDocument(disposition({ undocumented: true }))).to.throw(
      'must have exactly these fields',
    );
  });
});

describe('patched dispositions', () => {
  const noFindings = {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    },
  };
  const moderateReport = {
    ...auditReport,
    vulnerabilities: {
      vulnerable: {
        ...auditReport.vulnerabilities.vulnerable,
        severity: 'moderate',
        via: [{ ...auditReport.vulnerabilities.vulnerable.via[0], severity: 'moderate' }],
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 1, high: 0, critical: 0, total: 1 },
    },
  } as const;

  function patched(overrides: Readonly<Record<string, unknown>> = {}): unknown {
    return {
      schemaVersion: 1,
      reviewedAt: '2026-09-07',
      dispositions: [
        {
          package: 'vulnerable',
          advisory: 'GHSA-AAAA-BBBB-CCCC',
          severity: 'moderate',
          scope: 'shipped',
          classification: 'patched',
          owner: 'Test maintainers',
          verifiedBy: 'packages/example/test/fix.test.ts',
          reason: 'The installed release backports the fix; the advisory range does not credit it.',
          remediation: 'Nothing to renew; the named test fails if an unpatched release returns.',
          ...overrides,
        },
      ],
    };
  }
  const proof = (path: string): string | null =>
    path === 'packages/example/test/fix.test.ts' ? '// proves GHSA-AAAA-BBBB-CCCC' : null;

  it('never expires, and needs no periodic re-review', () => {
    // A year after the last review: a fix does not go stale on a calendar.
    expect(evaluateAudit(moderateReport, patched(), '2027-09-07', proof).failures).to.deep.equal(
      [],
    );
  });

  it('refuses an expiry, and requires a verification test instead', () => {
    expect(() => parseDispositionDocument(patched({ expires: '2026-10-01' }))).to.throw(
      'must have exactly these fields',
    );
    const { verifiedBy: _omitted, ...rest } = (
      patched() as { dispositions: [Record<string, unknown>] }
    ).dispositions[0];
    expect(() =>
      parseDispositionDocument({
        schemaVersion: 1,
        reviewedAt: '2026-09-07',
        dispositions: [rest],
      }),
    ).to.throw('must have exactly these fields');
  });

  it('only accepts a test file inside the repository', () => {
    for (const verifiedBy of ['../elsewhere/fix.test.ts', '/abs/fix.test.ts', 'packages/fix.ts']) {
      expect(() => parseDispositionDocument(patched({ verifiedBy })), verifiedBy).to.throw(
        'verifiedBy must be a repo-relative',
      );
    }
  });

  it('fails when the named test is missing or does not cite the advisory', () => {
    expect(
      evaluateAudit(moderateReport, patched(), '2026-09-07', () => null).failures.join('\n'),
    ).to.include('names a missing test');
    expect(
      evaluateAudit(moderateReport, patched(), '2026-09-07', () => '// unrelated').failures.join(
        '\n',
      ),
    ).to.include('does not cite the advisory');
  });

  it('still cannot wave through a high-severity shipped finding', () => {
    expect(
      evaluateAudit(auditReport, patched({ severity: 'high' }), '2026-09-07', proof).failures.join(
        '\n',
      ),
    ).to.include('cannot be dispositioned');
  });

  it('turns into a notice, not a failure, once npm stops reporting it', () => {
    // The advisory being corrected must not break a build on the day it happens.
    const evaluation = evaluateAudit(noFindings, patched(), '2026-09-07', proof);
    expect(evaluation.failures).to.deep.equal([]);
    expect(evaluation.notices.join('\n')).to.include('can be deleted');
  });

  it('keeps the review clock for risks still being carried', () => {
    const mixed = patched();
    (mixed as { dispositions: unknown[] }).dispositions.push(
      (disposition() as { dispositions: unknown[] }).dispositions[0],
    );
    expect(evaluateAudit(auditReport, mixed, '2026-11-01', proof).failures.join('\n')).to.include(
      'more than 30 days old',
    );
  });
});
