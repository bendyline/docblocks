/** Stable error codes shared by every filesystem transport and backend. */
export type FsErrorCode =
  | 'invalid-path'
  | 'path-escape'
  | 'not-found'
  | 'already-exists'
  | 'type-mismatch'
  | 'not-empty'
  | 'permission-denied'
  | 'conflict'
  | 'corrupt'
  | 'quota-exceeded'
  | 'not-supported'
  | 'busy'
  | 'disposed'
  | 'closed'
  | 'aborted'
  | 'io';

export type FsOperation =
  | 'parse-path'
  | 'read'
  | 'stat'
  | 'list'
  | 'write'
  | 'create-directory'
  | 'remove'
  | 'move'
  | 'snapshot'
  | 'watch'
  | 'dispose';

/** Plain-data form safe to send over IPC, postMessage, or JSON. */
export interface SerializedFsError {
  readonly name: 'FsError';
  readonly code: FsErrorCode;
  readonly message: string;
  readonly operation: FsOperation | null;
  readonly path: string | null;
  readonly destinationPath: string | null;
  readonly retryable: boolean;
}

export interface FsErrorContext {
  readonly operation?: FsOperation;
  readonly path?: string;
  readonly destinationPath?: string;
  readonly retryable?: boolean;
  readonly defaultCode?: FsErrorCode;
}

const FS_ERROR_CODES: ReadonlySet<string> = new Set<FsErrorCode>([
  'invalid-path',
  'path-escape',
  'not-found',
  'already-exists',
  'type-mismatch',
  'not-empty',
  'permission-denied',
  'conflict',
  'corrupt',
  'quota-exceeded',
  'not-supported',
  'busy',
  'disposed',
  'closed',
  'aborted',
  'io',
]);

const FS_OPERATIONS: ReadonlySet<string> = new Set<FsOperation>([
  'parse-path',
  'read',
  'stat',
  'list',
  'write',
  'create-directory',
  'remove',
  'move',
  'snapshot',
  'watch',
  'dispose',
]);

/** Error with a stable code and a deliberately serializable public shape. */
export class FsError extends Error {
  public readonly code: FsErrorCode;
  public readonly operation: FsOperation | null;
  public readonly path: string | null;
  public readonly destinationPath: string | null;
  public readonly retryable: boolean;

  public constructor(code: FsErrorCode, message: string, context: FsErrorContext = {}) {
    super(message);
    this.name = 'FsError';
    this.code = code;
    this.operation = context.operation ?? null;
    this.path = context.path ?? null;
    this.destinationPath = context.destinationPath ?? null;
    this.retryable = context.retryable ?? (code === 'io' || code === 'aborted' || code === 'busy');
  }

  public toJSON(): SerializedFsError {
    return {
      name: 'FsError',
      code: this.code,
      message: this.message,
      operation: this.operation,
      path: this.path,
      destinationPath: this.destinationPath,
      retryable: this.retryable,
    };
  }
}

export function mapDomExceptionToFsErrorCode(name: string): FsErrorCode {
  switch (name) {
    case 'NotFoundError':
      return 'not-found';
    case 'ConstraintError':
      return 'already-exists';
    case 'TypeMismatchError':
      return 'type-mismatch';
    case 'InvalidModificationError':
      return 'not-empty';
    case 'NotAllowedError':
    case 'SecurityError':
    case 'NoModificationAllowedError':
      return 'permission-denied';
    case 'QuotaExceededError':
      return 'quota-exceeded';
    case 'NotSupportedError':
      return 'not-supported';
    case 'InvalidStateError':
      return 'disposed';
    case 'AbortError':
      return 'aborted';
    default:
      return 'io';
  }
}

export function mapNodeErrorCodeToFsErrorCode(code: string): FsErrorCode {
  switch (code) {
    case 'ENOENT':
      return 'not-found';
    case 'ENOTDIR':
      return 'type-mismatch';
    case 'EEXIST':
      return 'already-exists';
    case 'EISDIR':
      return 'type-mismatch';
    case 'ENOTEMPTY':
      return 'not-empty';
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied';
    case 'ENOSPC':
    case 'EDQUOT':
      return 'quota-exceeded';
    case 'EBUSY':
      return 'busy';
    case 'EXDEV':
    case 'ENOTSUP':
    case 'EOPNOTSUPP':
      return 'not-supported';
    default:
      return 'io';
  }
}

export function isSerializedFsError(value: unknown): value is SerializedFsError {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Record<keyof SerializedFsError, unknown>>;
  return (
    candidate.name === 'FsError' &&
    typeof candidate.code === 'string' &&
    FS_ERROR_CODES.has(candidate.code) &&
    typeof candidate.message === 'string' &&
    (candidate.operation === null ||
      (typeof candidate.operation === 'string' && FS_OPERATIONS.has(candidate.operation))) &&
    (candidate.path === null || typeof candidate.path === 'string') &&
    (candidate.destinationPath === null || typeof candidate.destinationPath === 'string') &&
    typeof candidate.retryable === 'boolean'
  );
}

export function deserializeFsError(value: SerializedFsError): FsError {
  return new FsError(value.code, value.message, {
    operation: value.operation ?? undefined,
    path: value.path ?? undefined,
    destinationPath: value.destinationPath ?? undefined,
    retryable: value.retryable,
  });
}

export function fsErrorFromUnknown(error: unknown, context: FsErrorContext = {}): FsError {
  if (error instanceof FsError) return error;
  if (isSerializedFsError(error)) return deserializeFsError(error);

  const name = getErrorStringField(error, 'name');
  const nodeCode = getErrorStringField(error, 'code');
  const message = getErrorStringField(error, 'message') ?? String(error);
  const code =
    context.defaultCode ??
    (nodeCode
      ? mapNodeErrorCodeToFsErrorCode(nodeCode)
      : name
        ? mapDomExceptionToFsErrorCode(name)
        : 'io');
  return new FsError(code, message, context);
}

export function serializeFsError(error: unknown, context: FsErrorContext = {}): SerializedFsError {
  return fsErrorFromUnknown(error, context).toJSON();
}

/**
 * True when a storage backend rejected an operation because the origin or
 * device is out of space. Covers typed `FsError`s (`'quota-exceeded'`, from
 * DOMException `QuotaExceededError` or Node `ENOSPC`/`EDQUOT`), serialized
 * transport copies, and raw DOMExceptions from backends that do not wrap
 * their errors (e.g. the File System Access API) — including cross-realm
 * instances where `instanceof DOMException` would fail.
 */
export function isQuotaExceededError(error: unknown): boolean {
  if (error instanceof FsError) return error.code === 'quota-exceeded';
  if (isSerializedFsError(error)) return error.code === 'quota-exceeded';
  return getErrorStringField(error, 'name') === 'QuotaExceededError';
}

function getErrorStringField(error: unknown, key: 'name' | 'message' | 'code'): string | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}
