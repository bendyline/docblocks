/**
 * WorkspaceRoots — whitelist of absolute directory paths this window is
 * allowed to touch. Filesystem IPC handlers use the physical resolvers below,
 * which reject unregistered roots, lexical traversal, workspace-root
 * mutation, and symlink/junction ancestors that leave the granted root.
 *
 * This is the security boundary between the renderer and the native fs.
 */

import fss from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface WorkspaceRootEntry {
  id: string;
  rootPath: string;
}

export type WorkspaceRootErrorCode =
  | 'not-registered'
  | 'path-escape'
  | 'root-changed'
  | 'root-mutation';

export class WorkspaceRootError extends Error {
  public constructor(
    public readonly code: WorkspaceRootErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceRootError';
  }
}

interface RegisteredWorkspaceRoot extends WorkspaceRootEntry {
  /** Physical target captured when this root first became accessible. */
  physicalRoot?: string;
}

export interface WorkspaceRoots {
  register(id: string, rootPath: string): void;
  unregister(id: string): void;
  get(id: string): WorkspaceRootEntry | null;
  list(): WorkspaceRootEntry[];
  resolve(rootPath: string, relPath: string): string;
  resolvePhysical(rootPath: string, relPath: string): Promise<string>;
  resolveMutation(rootPath: string, relPath: string): Promise<string>;
  _reset(): void;
}

let roots = new Map<string, RegisteredWorkspaceRoot>();

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function tryRealpath(rootPath: string): string | undefined {
  try {
    return fss.realpathSync.native(rootPath);
  } catch {
    // A sandbox grant may not be active yet, or a previously saved folder may
    // currently be offline. The first successful operation will pin it.
    return undefined;
  }
}

export function isPathInside(rootAbs: string, candidateAbs: string): boolean {
  const rel = path.relative(path.resolve(rootAbs), path.resolve(candidateAbs));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function findRegisteredRoot(rootPath: string): RegisteredWorkspaceRoot {
  const abs = path.resolve(rootPath);
  const entry = [...roots.values()].find((item) => samePath(item.rootPath, abs));
  if (!entry) {
    throw new WorkspaceRootError('not-registered', `Workspace root not registered: ${rootPath}`);
  }
  return entry;
}

function resolveLexically(
  rootPath: string,
  relPath: string,
): {
  entry: RegisteredWorkspaceRoot;
  rootAbs: string;
  candidate: string;
} {
  const entry = findRegisteredRoot(rootPath);
  const rootAbs = entry.rootPath;
  const normalized = relPath.replace(/^\/+/, '');
  const candidate = path.resolve(rootAbs, normalized);
  if (!isPathInside(rootAbs, candidate)) {
    throw new WorkspaceRootError('path-escape', `Path escapes workspace root: ${relPath}`);
  }
  return { entry, rootAbs, candidate };
}

function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function physicallyAnchoredCandidate(candidate: string, rootAbs: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      await fs.lstat(current);
    } catch (error: unknown) {
      if (!isMissingPath(error)) throw error;
      if (samePath(current, rootAbs)) throw error;
      current = path.dirname(current);
      continue;
    }

    // lstat sees dangling symlinks. Keep realpath outside the missing-path
    // catch: an unresolved link is not equivalent to a path that is safe to
    // create, because its target can later appear outside the root.
    //
    // Anchor the returned path at the physical ancestor rather than returning
    // the renderer-facing lexical spelling. If a contained link is retargeted
    // after authorization, the operation still addresses the physical target
    // that was authorized instead of following the changed link.
    const physicalAncestor = await fs.realpath(current);
    return path.resolve(physicalAncestor, path.relative(current, candidate));
  }
}

async function assertNoLinkComponents(rootAbs: string, candidate: string): Promise<void> {
  const relative = path.relative(rootAbs, candidate);
  let current = rootAbs;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(current);
    } catch (error: unknown) {
      if (isMissingPath(error)) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new WorkspaceRootError(
        'path-escape',
        `Workspace mutations cannot traverse a symbolic link or junction: ${relative}`,
      );
    }
  }
}

async function resolvePhysically(
  rootPath: string,
  relPath: string,
): Promise<{
  rootAbs: string;
  candidate: string;
}> {
  const { entry, rootAbs, candidate } = resolveLexically(rootPath, relPath);
  const currentPhysicalRoot = await fs.realpath(rootAbs);
  if (entry.physicalRoot && !samePath(entry.physicalRoot, currentPhysicalRoot)) {
    throw new WorkspaceRootError(
      'root-changed',
      `Workspace root changed physical target: ${rootPath}`,
    );
  }
  entry.physicalRoot ??= currentPhysicalRoot;

  const physicalCandidate = await physicallyAnchoredCandidate(candidate, rootAbs);
  if (!isPathInside(entry.physicalRoot, physicalCandidate)) {
    throw new WorkspaceRootError(
      'path-escape',
      `Path escapes workspace root through a symbolic link: ${relPath}`,
    );
  }
  return { rootAbs: entry.physicalRoot, candidate: physicalCandidate };
}

export function getWorkspaceRoots(): WorkspaceRoots {
  return {
    register(id: string, rootPath: string) {
      const resolved = path.resolve(rootPath);
      const existing = roots.get(id);
      roots.set(id, {
        id,
        rootPath: resolved,
        physicalRoot:
          existing && samePath(existing.rootPath, resolved)
            ? existing.physicalRoot
            : tryRealpath(resolved),
      });
    },
    unregister(id: string) {
      roots.delete(id);
    },
    get(id: string): WorkspaceRootEntry | null {
      const entry = roots.get(id);
      return entry ? { id: entry.id, rootPath: entry.rootPath } : null;
    },
    list(): WorkspaceRootEntry[] {
      return [...roots.values()].map(({ id, rootPath }) => ({ id, rootPath }));
    },
    /**
     * Lexically resolve a path for identity/lock bookkeeping. Native I/O must
     * use resolvePhysical or resolveMutation instead.
     */
    resolve(rootPath: string, relPath: string): string {
      return resolveLexically(rootPath, relPath).candidate;
    },
    /** Resolve a read target after validating its nearest existing ancestor. */
    async resolvePhysical(rootPath: string, relPath: string): Promise<string> {
      return (await resolvePhysically(rootPath, relPath)).candidate;
    },
    /** Resolve a mutation target and reject the registered root itself. */
    async resolveMutation(rootPath: string, relPath: string): Promise<string> {
      const lexical = resolveLexically(rootPath, relPath);
      await assertNoLinkComponents(lexical.rootAbs, lexical.candidate);
      const resolved = await resolvePhysically(rootPath, relPath);
      if (samePath(resolved.rootAbs, resolved.candidate)) {
        throw new WorkspaceRootError('root-mutation', 'The workspace root cannot be mutated.');
      }
      return resolved.candidate;
    },
    /** For tests only — reset all state. */
    _reset() {
      roots = new Map();
    },
  };
}
