import { HOST_WIRE_LIMITS, isBoundedString } from '@bendyline/docblocks/host';
import type { ExportTargetGrantMessage } from '@bendyline/docblocks/vscode';

const DEFAULT_GRANT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_GRANTS = 32;

export interface ExportGrantScope {
  panelId: string;
  documentUri: string;
}

interface StoredGrant<T> {
  scopeKey: string;
  target: T;
  displayLabel: string;
  expiresAt: number;
}

export interface ExportTargetGrantRegistryOptions {
  createGrantId?: () => string;
  now?: () => number;
  ttlMs?: number;
  maxGrants?: number;
}

/**
 * Stores export authority entirely in the extension host. Grant IDs are
 * unguessable, panel/document scoped, bounded, expiring, and consumed before
 * the privileged write so a captured message cannot be replayed.
 */
export class ExportTargetGrantRegistry<T> {
  private readonly grants = new Map<string, StoredGrant<T>>();
  private readonly createGrantId: () => string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxGrants: number;

  constructor(options: ExportTargetGrantRegistryOptions = {}) {
    this.createGrantId = options.createGrantId ?? createRandomGrantId;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_GRANT_TTL_MS;
    this.maxGrants = options.maxGrants ?? DEFAULT_MAX_GRANTS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error('Export grant TTL must be a positive integer');
    }
    if (!Number.isSafeInteger(this.maxGrants) || this.maxGrants <= 0) {
      throw new Error('Export grant capacity must be a positive integer');
    }
  }

  issue(scope: ExportGrantScope, target: T, displayLabel: string): ExportTargetGrantMessage {
    validateScope(scope);
    if (!isBoundedString(displayLabel, HOST_WIRE_LIMITS.pathCharacters, 1)) {
      throw new Error('Export target label is invalid');
    }

    this.pruneExpired();
    while (this.grants.size >= this.maxGrants) {
      const oldest = this.grants.keys().next().value as string | undefined;
      if (!oldest) break;
      this.grants.delete(oldest);
    }

    let grantId = '';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = this.createGrantId();
      if (
        isBoundedString(candidate, HOST_WIRE_LIMITS.identifierCharacters, 1) &&
        !this.grants.has(candidate)
      ) {
        grantId = candidate;
        break;
      }
    }
    if (!grantId) throw new Error('Could not create an export target grant');

    this.grants.set(grantId, {
      scopeKey: toScopeKey(scope),
      target,
      displayLabel,
      expiresAt: this.now() + this.ttlMs,
    });
    return { grantId, displayLabel };
  }

  peek(scope: ExportGrantScope, grantId: string): T {
    return this.requireGrant(scope, grantId).target;
  }

  consume(scope: ExportGrantScope, grantId: string): T {
    const grant = this.requireGrant(scope, grantId);
    this.grants.delete(grantId);
    return grant.target;
  }

  revoke(scope: ExportGrantScope, grantId: string): void {
    this.requireGrant(scope, grantId);
    this.grants.delete(grantId);
  }

  revokeScope(scope: ExportGrantScope): void {
    const scopeKey = toScopeKey(scope);
    for (const [grantId, grant] of this.grants) {
      if (grant.scopeKey === scopeKey) this.grants.delete(grantId);
    }
  }

  private requireGrant(scope: ExportGrantScope, grantId: string): StoredGrant<T> {
    validateScope(scope);
    if (!isBoundedString(grantId, HOST_WIRE_LIMITS.identifierCharacters, 1)) {
      throw invalidGrantError();
    }
    const grant = this.grants.get(grantId);
    if (!grant || grant.scopeKey !== toScopeKey(scope)) throw invalidGrantError();
    if (grant.expiresAt <= this.now()) {
      this.grants.delete(grantId);
      throw invalidGrantError();
    }
    return grant;
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [grantId, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(grantId);
    }
  }
}

function validateScope(scope: ExportGrantScope): void {
  if (
    !isBoundedString(scope.panelId, HOST_WIRE_LIMITS.identifierCharacters, 1) ||
    !isBoundedString(scope.documentUri, HOST_WIRE_LIMITS.urlCharacters, 1)
  ) {
    throw new Error('Export grant scope is invalid');
  }
}

function toScopeKey(scope: ExportGrantScope): string {
  return `${scope.panelId}\0${scope.documentUri}`;
}

function invalidGrantError(): Error {
  return new Error('The export target grant is invalid, expired, or already used. Choose again.');
}

function createRandomGrantId(): string {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return `export_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
