import { parseWorkspacePath } from '../../src/filesystem/workspace-path.js';

export type NativeEmulatorOperation =
  | 'get-file'
  | 'get-directory'
  | 'get-file-data'
  | 'array-buffer'
  | 'create-writable'
  | 'write'
  | 'close'
  | 'remove';

interface FileNode {
  readonly kind: 'file';
  readonly name: string;
  data: ArrayBuffer;
  lastModified: number;
}

interface DirectoryNode {
  readonly kind: 'directory';
  readonly name: string;
  readonly children: Map<string, NativeNode>;
}

type NativeNode = FileNode | DirectoryNode;

interface InjectedFault {
  readonly operation: NativeEmulatorOperation;
  readonly path: string;
  readonly error: unknown;
  remainingMatches: number;
}

interface ObservedOperation {
  readonly operation: NativeEmulatorOperation;
  readonly path: string;
}

interface PartialRemoval {
  readonly path: string;
  readonly deletedChildNames: readonly string[];
  readonly error: unknown;
}

/** Stateful File System Access API emulator used by native-v2 conformance tests. */
export class NativeFileSystemEmulator {
  public readonly rootHandle: FileSystemDirectoryHandle;

  private readonly root: DirectoryNode;
  private readonly faults: InjectedFault[] = [];
  private readonly partialRemovals: PartialRemoval[] = [];
  private readonly observedOperations: ObservedOperation[] = [];
  private clock = 1;

  public constructor(name = 'workspace') {
    this.root = { kind: 'directory', name, children: new Map() };
    this.rootHandle = this.directoryHandle(this.root, '');
  }

  public failNext(operation: NativeEmulatorOperation, path: string, error: unknown): void {
    this.failOnCall(operation, path, 1, error);
  }

  public failOnCall(
    operation: NativeEmulatorOperation,
    path: string,
    occurrence: number,
    error: unknown,
  ): void {
    if (!Number.isSafeInteger(occurrence) || occurrence < 1) {
      throw new RangeError('Fault occurrence must be a positive integer.');
    }
    this.faults.push({
      operation,
      path: parseWorkspacePath(path),
      error,
      remainingMatches: occurrence - 1,
    });
  }

  /**
   * Make the next removal of `path` delete `deletedChildNames` and then fail,
   * the way a real filesystem does when it cannot unlink one entry partway
   * through a recursive delete. Ordinary injected faults throw before touching
   * anything, so they cannot express the state this models: a directory that is
   * still present but has already lost children.
   */
  public failRemoveAfterDeleting(
    path: string,
    deletedChildNames: readonly string[],
    error: unknown,
  ): void {
    this.partialRemovals.push({
      path: parseWorkspacePath(path),
      deletedChildNames: [...deletedChildNames],
      error,
    });
  }

  public operationCount(operation: NativeEmulatorOperation, path?: string): number {
    const canonical = path === undefined ? null : parseWorkspacePath(path);
    return this.observedOperations.filter(
      (observed) =>
        observed.operation === operation && (canonical === null || observed.path === canonical),
    ).length;
  }

  public resetOperationCounts(): void {
    this.observedOperations.length = 0;
  }

  public seedFile(path: string, data: ArrayBuffer | Uint8Array | string): void {
    const canonical = parseWorkspacePath(path);
    if (!canonical) throw new Error('Cannot seed the workspace root as a file.');
    const parent = this.ensureDirectory(parentPath(canonical));
    const bytes = toBytes(data);
    parent.children.set(baseName(canonical), {
      kind: 'file',
      name: baseName(canonical),
      data: bytes,
      lastModified: ++this.clock,
    });
  }

  public seedDirectory(path: string): void {
    this.ensureDirectory(parseWorkspacePath(path));
  }

  public exists(path: string): boolean {
    return this.node(parseWorkspacePath(path)) !== null;
  }

  public readBytes(path: string): number[] | null {
    const node = this.node(parseWorkspacePath(path));
    return node?.kind === 'file' ? [...new Uint8Array(node.data)] : null;
  }

  private directoryHandle(node: DirectoryNode, path: string): FileSystemDirectoryHandle {
    const createFileHandle = (child: FileNode, childPath: string) =>
      this.fileHandle(child, childPath);
    const createDirectoryHandle = (child: DirectoryNode, childPath: string) =>
      this.directoryHandle(child, childPath);
    const handle = {
      kind: 'directory' as const,
      name: node.name,
      getFileHandle: async (name: string, options: { create?: boolean } = {}) => {
        const childPath = joinPath(path, name);
        this.consumeFault('get-file', childPath);
        const child = node.children.get(name);
        if (child?.kind === 'directory') throw domError('TypeMismatchError');
        if (child?.kind === 'file') return createFileHandle(child, childPath);
        if (!options.create) throw domError('NotFoundError');
        const created: FileNode = {
          kind: 'file',
          name,
          data: new ArrayBuffer(0),
          lastModified: ++this.clock,
        };
        node.children.set(name, created);
        return createFileHandle(created, childPath);
      },
      getDirectoryHandle: async (name: string, options: { create?: boolean } = {}) => {
        const childPath = joinPath(path, name);
        this.consumeFault('get-directory', childPath);
        const child = node.children.get(name);
        if (child?.kind === 'file') throw domError('TypeMismatchError');
        if (child?.kind === 'directory') return createDirectoryHandle(child, childPath);
        if (!options.create) throw domError('NotFoundError');
        const created: DirectoryNode = { kind: 'directory', name, children: new Map() };
        node.children.set(name, created);
        return createDirectoryHandle(created, childPath);
      },
      removeEntry: async (name: string, options: { recursive?: boolean } = {}) => {
        const childPath = joinPath(path, name);
        this.consumeFault('remove', childPath);
        const child = node.children.get(name);
        if (!child) throw domError('NotFoundError');
        if (child.kind === 'directory' && child.children.size > 0 && !options.recursive) {
          throw domError('InvalidModificationError');
        }
        const partial = this.consumePartialRemoval(childPath);
        if (partial) {
          if (child.kind === 'directory') {
            for (const victim of partial.deletedChildNames) child.children.delete(victim);
          }
          throw partial.error;
        }
        node.children.delete(name);
      },
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<
        readonly [string, FileSystemHandle]
      > {
        const children = [...node.children.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        );
        for (const [name, child] of children) {
          const childPath = joinPath(path, name);
          yield [
            name,
            child.kind === 'file'
              ? createFileHandle(child, childPath)
              : createDirectoryHandle(child, childPath),
          ] as const;
        }
      },
    };
    return handle as unknown as FileSystemDirectoryHandle;
  }

  private fileHandle(node: FileNode, path: string): FileSystemFileHandle {
    const handle = {
      kind: 'file' as const,
      name: node.name,
      getFile: async (): Promise<File> => {
        this.consumeFault('get-file-data', path);
        const snapshot = node.data.slice(0);
        const lastModified = node.lastModified;
        return {
          name: node.name,
          size: snapshot.byteLength,
          lastModified,
          arrayBuffer: async () => {
            this.consumeFault('array-buffer', path);
            return snapshot.slice(0);
          },
          text: async () => new TextDecoder().decode(snapshot),
        } as unknown as File;
      },
      createWritable: async (): Promise<FileSystemWritableFileStream> => {
        this.consumeFault('create-writable', path);
        let pending = node.data.slice(0);
        let closed = false;
        const writable = {
          write: async (data: unknown) => {
            this.consumeFault('write', path);
            pending = toBytes(data);
          },
          close: async () => {
            this.consumeFault('close', path);
            if (closed) return;
            node.data = pending.slice(0);
            node.lastModified = ++this.clock;
            closed = true;
          },
          abort: async () => {
            closed = true;
          },
        };
        return writable as unknown as FileSystemWritableFileStream;
      },
    };
    return handle as unknown as FileSystemFileHandle;
  }

  private consumePartialRemoval(path: string): PartialRemoval | null {
    const index = this.partialRemovals.findIndex((removal) => removal.path === path);
    if (index < 0) return null;
    const [removal] = this.partialRemovals.splice(index, 1);
    return removal;
  }

  private consumeFault(operation: NativeEmulatorOperation, path: string): void {
    this.observedOperations.push({ operation, path });
    const index = this.faults.findIndex(
      (fault) => fault.operation === operation && fault.path === path,
    );
    if (index < 0) return;
    if (this.faults[index].remainingMatches > 0) {
      this.faults[index].remainingMatches -= 1;
      return;
    }
    const [fault] = this.faults.splice(index, 1);
    throw fault.error;
  }

  private node(path: string): NativeNode | null {
    if (!path) return this.root;
    let current: NativeNode = this.root;
    for (const segment of path.split('/')) {
      if (current.kind !== 'directory') return null;
      const next = current.children.get(segment);
      if (!next) return null;
      current = next;
    }
    return current;
  }

  private ensureDirectory(path: string): DirectoryNode {
    let current = this.root;
    if (!path) return current;
    for (const segment of path.split('/')) {
      const existing = current.children.get(segment);
      if (existing?.kind === 'file') throw new Error(`${segment} is a file.`);
      if (existing) {
        current = existing;
      } else {
        const created: DirectoryNode = {
          kind: 'directory',
          name: segment,
          children: new Map(),
        };
        current.children.set(segment, created);
        current = created;
      }
    }
    return current;
  }
}

export function nativeDomError(name: string, message = name): DOMException {
  return domError(name, message);
}

function domError(name: string, message = name): DOMException {
  return new DOMException(message, name);
}

function toBytes(data: unknown): ArrayBuffer {
  if (typeof data === 'string') return new TextEncoder().encode(data).buffer as ArrayBuffer;
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data)) {
    const view = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return view.slice().buffer as ArrayBuffer;
  }
  throw new TypeError('Unsupported writable payload.');
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}
