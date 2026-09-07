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
