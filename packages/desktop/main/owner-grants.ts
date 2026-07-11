import { randomUUID } from 'node:crypto';

interface OwnerGrant<T> {
  ownerId: number;
  value: T;
}

/**
 * In-memory, unforgeable capabilities scoped to one renderer WebContents.
 *
 * The renderer may display a grant id and return it over IPC, but it can
 * neither manufacture a grant for another resource nor replay one from a
 * different window. Grants intentionally never survive process restart.
 */
export class OwnerGrantStore<T> {
  readonly #prefix: string;
  readonly #grants = new Map<string, OwnerGrant<T>>();

  public constructor(prefix: string) {
    this.#prefix = prefix;
  }

  public mint(ownerId: number, value: T): string {
    const grantId = `${this.#prefix}_${randomUUID()}`;
    this.#grants.set(grantId, { ownerId, value });
    return grantId;
  }

  public require(ownerId: number, grantId: string): T {
    const grant = this.#grants.get(grantId);
    if (!grant || grant.ownerId !== ownerId) {
      throw new Error('Resource grant is invalid, expired, or belongs to another window');
    }
    return grant.value;
  }

  public get(ownerId: number, grantId: string): T | null {
    const grant = this.#grants.get(grantId);
    return grant?.ownerId === ownerId ? grant.value : null;
  }

  public entries(ownerId: number): ReadonlyArray<Readonly<{ grantId: string; value: T }>> {
    const result: Array<Readonly<{ grantId: string; value: T }>> = [];
    for (const [grantId, grant] of this.#grants) {
      if (grant.ownerId === ownerId) result.push({ grantId, value: grant.value });
    }
    return result;
  }

  public revoke(ownerId: number, grantId: string): boolean {
    const grant = this.#grants.get(grantId);
    return grant?.ownerId === ownerId ? this.#grants.delete(grantId) : false;
  }

  public revokeOwner(ownerId: number): readonly string[] {
    const revoked: string[] = [];
    for (const [grantId, grant] of this.#grants) {
      if (grant.ownerId !== ownerId) continue;
      this.#grants.delete(grantId);
      revoked.push(grantId);
    }
    return revoked;
  }

  /** Test-only visibility without exposing grant contents. */
  public has(ownerId: number, grantId: string): boolean {
    const grant = this.#grants.get(grantId);
    return grant?.ownerId === ownerId;
  }
}
