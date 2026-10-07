import { expect } from 'chai';
import {
  evaluateAudit,
  normalizeAuditReport,
  parseExceptions,
} from '../../../scripts/check-dependency-audit.js';

type Severity = 'low' | 'moderate' | 'high' | 'critical';

function auditReport(severity: Severity): unknown {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      vulnerable: {
        name: 'vulnerable',
        severity,
        isDirect: false,
        via: [
          {
            source: 123,
            name: 'vulnerable',
            dependency: 'vulnerable',
            title: 'Synthetic advisory',
            url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
            severity,
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
        severity,
        isDirect: true,
        via: ['vulnerable'],
        effects: [],
        range: '*',
        nodes: ['node_modules/consumer'],
        fixAvailable: true,
      },
    },
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 2 },
    },
  };
}

const noFindings = { auditReportVersion: 2, vulnerabilities: {}, metadata: {} };

describe('dependency audit policy', () => {
  it('normalizes advisory objects without duplicating dependency fan-out strings', () => {
    const findings = normalizeAuditReport(auditReport('high'));
    expect(findings).to.have.length(1);
    expect(findings[0]).to.include({
      package: 'vulnerable',
      advisory: 'GHSA-AAAA-BBBB-CCCC',
      severity: 'high',
    });
  });

  it('reports but does not block anything below critical', () => {
    for (const severity of ['low', 'moderate', 'high'] as const) {
      const evaluation = evaluateAudit(auditReport(severity), {});
      expect(evaluation.findings, severity).to.have.length(1);
      expect(evaluation.failures, severity).to.deep.equal([]);
    }
  });

  it('blocks a critical advisory', () => {
    expect(evaluateAudit(auditReport('critical'), {}).failures.join('\n')).to.include(
      'critical vulnerable GHSA-AAAA-BBBB-CCCC',
    );
  });

  it('lets an exception carry a critical advisory, matched case-insensitively', () => {
    const exceptions = { 'ghsa-aaaa-bbbb-cccc': 'Fix is still inside the release cooldown.' };
    expect(evaluateAudit(auditReport('critical'), exceptions).failures).to.deep.equal([]);
  });

  it('turns an exception npm no longer reports into a notice, not a failure', () => {
    const evaluation = evaluateAudit(noFindings, { 'GHSA-AAAA-BBBB-CCCC': 'Waiting on a fix.' });
    expect(evaluation.failures).to.deep.equal([]);
    expect(evaluation.notices.join('\n')).to.include('can be deleted');
  });

  it('requires every exception to give a reason', () => {
    expect(() => parseExceptions({ 'GHSA-AAAA-BBBB-CCCC': '' })).to.throw('non-empty string');
    expect(() => parseExceptions(['GHSA-AAAA-BBBB-CCCC'])).to.throw('map advisory IDs');
  });
});
