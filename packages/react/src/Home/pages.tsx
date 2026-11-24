/**
 * The shell's own pages, loaded together on first use so none of them adds
 * to what every launch downloads.
 */

import type { KindFolder } from '@bendyline/docblocks/folders';
import { useMemo } from 'react';
import { HomePage } from './HomePage.js';
import { JournalPage } from './JournalPage.js';
import type { ShellPageContext } from './page-context.js';
import { TasksFolderPage } from './TasksFolderPage.js';
import { TasksPage } from './TasksPage.js';
import { UnfiledPage } from './UnfiledPage.js';
import type { ShellRoute } from './shell-routes.js';

export interface ShellPageProps {
  readonly context: ShellPageContext;
  /** Home or Tasks; folders are shown through `KindFolderPage`, and Ask by the shell. */
  readonly route: Extract<ShellRoute, { kind: 'home' | 'tasks' }>;
}

export function ShellPage({ context, route }: ShellPageProps) {
  return route.kind === 'home' ? <HomePage context={context} /> : <TasksPage context={context} />;
}

/** The page for a folder that says what it is for. */
export function KindFolderPage({
  context,
  folder,
}: {
  context: ShellPageContext;
  folder: KindFolder;
}) {
  const directories = useMemo(
    () => context.index?.getDirectories() ?? [],
    // `generation` is the index's change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [context.index, context.generation],
  );
  switch (folder.settings.kind) {
    case 'tasks':
      return <TasksFolderPage context={context} folder={folder} directories={directories} />;
    case 'journal':
      return <JournalPage context={context} folder={folder} />;
    case 'unfiled':
      return <UnfiledPage context={context} folder={folder} />;
  }
}
