import type { ComponentType } from 'react';
import type { FolderKind } from '@bendyline/docblocks/folders';
import {
  ArchiveFileIcon,
  AudioFileIcon,
  ChatsIcon,
  CodeFileIcon,
  DataFileIcon,
  DocumentFileIcon,
  FolderIcon,
  GenericFileIcon,
  ImageFileIcon,
  JournalIcon,
  PresentationFileIcon,
  SpreadsheetFileIcon,
  TasksIcon,
  UnfiledIcon,
  VideoFileIcon,
} from '../icons.js';
import type { FileTypeGlyph, TreeEntryGlyph } from './entry-glyph.js';

/** The same glyphs the sidebar header's place buttons wear (chats are Ask's). */
const KIND_GLYPHS: Record<FolderKind, ComponentType> = {
  tasks: TasksIcon,
  journal: JournalIcon,
  unfiled: UnfiledIcon,
  chats: ChatsIcon,
};

const FILE_GLYPHS: Record<FileTypeGlyph, ComponentType> = {
  document: DocumentFileIcon,
  spreadsheet: SpreadsheetFileIcon,
  presentation: PresentationFileIcon,
  web: CodeFileIcon,
  image: ImageFileIcon,
  video: VideoFileIcon,
  audio: AudioFileIcon,
  code: CodeFileIcon,
  data: DataFileIcon,
  archive: ArchiveFileIcon,
  file: GenericFileIcon,
};

const GLYPHS: Record<TreeEntryGlyph, ComponentType> = {
  folder: FolderIcon,
  ...KIND_GLYPHS,
  ...FILE_GLYPHS,
};

/** Decorative: the row's name already says what it is. */
export function TreeEntryIcon({ glyph }: { glyph: TreeEntryGlyph }) {
  const Glyph = GLYPHS[glyph];
  return (
    <span className="db-tree-glyph" data-glyph={glyph} aria-hidden="true">
      <Glyph />
    </span>
  );
}
