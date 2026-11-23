/**
 * DocBlocks shell icons: Lucide outlines, one family at one stroke weight, so
 * the shell's glyphs match each other and Squisq's toolbar. Each glyph sizes
 * from its control's `font-size`, as the webfont glyphs it replaced did, so the
 * existing button rules keep working. Controls provide the accessible name, so
 * the glyphs themselves stay decorative.
 */

import {
  ArrowDownAZ,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  CircleCheck,
  Clock,
  Download,
  createLucideIcon,
  Ellipsis,
  Folder,
  FolderOpen,
  FileUp,
  FolderTree,
  PanelLeft,
  Pin,
  Search,
  Settings2,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';

/**
 * Lucide's sparkle at 0.45 scale, centered on (17.75, 6.25): the upper-right
 * corner of New File and New Folder. A plus there read too close to Import's
 * arrow at phone size; a sparkle in the corner says "new" without one.
 */
const CORNER_SPARKLE =
  'M17.308 2.116a0.45 0.45 0 0 1 0.885 0l0.473 2.501a0.9 0.9 0 0 0 0.717 0.717' +
  'l2.501 0.473a0.45 0.45 0 0 1 0 0.885l-2.501 0.473a0.9 0.9 0 0 0-0.717 0.717' +
  'l-0.473 2.501a0.45 0.45 0 0 1-0.885 0l-0.473-2.501a0.9 0.9 0 0 0-0.717-0.717' +
  'l-2.501-0.473a0.45 0.45 0 0 1 0-0.885l2.501-0.473a0.9 0.9 0 0 0 0.717-0.717z';

/** A page whose upper-right corner gives way to the sparkle. */
const FileSparkle = createLucideIcon('FileSparkle', [
  ['path', { d: 'M12 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8', key: 'page' }],
  ['path', { d: CORNER_SPARKLE, key: 'sparkle' }],
]);

/**
 * A folder whose upper-right corner gives way to the sparkle. The tab is a
 * little narrower than Lucide's Folder so it ends clear of the sparkle.
 */
const FolderSparkle = createLucideIcon('FolderSparkle', [
  [
    'path',
    {
      d: 'M22 11v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h2.43a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.69.9',
      key: 'folder',
    },
  ],
  ['path', { d: CORNER_SPARKLE, key: 'sparkle' }],
]);

/** Slightly over 1em: Lucide draws inside a 2px margin on its 24px grid. */
const ICON_SIZE = '1.15em';
/** 1.75 on the 24px grid renders as a ~1px line at the shell's 13–16px sizes. */
const STROKE_WIDTH = 1.75;

function ShellIcon({
  icon: Icon,
  size = ICON_SIZE,
  strokeWidth = STROKE_WIDTH,
}: {
  icon: LucideIcon;
  size?: string | number;
  strokeWidth?: number;
}) {
  return <Icon size={size} strokeWidth={strokeWidth} aria-hidden="true" focusable="false" />;
}

export function NewFileIcon() {
  return <ShellIcon icon={FileSparkle} />;
}

export function NewFolderIcon() {
  return <ShellIcon icon={FolderSparkle} />;
}

/**
 * The familiar Paste glyph rather than the "new" sparkle New File and New
 * Folder wear: what it makes a document from is what sets it apart.
 */
export function NewFromClipboardIcon() {
  return <ShellIcon icon={ClipboardPaste} />;
}

export function ImportFilesIcon() {
  return <ShellIcon icon={FileUp} />;
}

export function OpenFolderIcon() {
  return <ShellIcon icon={FolderOpen} />;
}

export function SortByNameIcon() {
  return <ShellIcon icon={ArrowDownAZ} />;
}

export function SortByLastModifiedIcon() {
  return <ShellIcon icon={Clock} />;
}

export function FolderIcon() {
  return <ShellIcon icon={Folder} />;
}

export function MoreIcon() {
  return <ShellIcon icon={Ellipsis} />;
}

export function PinIcon() {
  return <ShellIcon icon={Pin} />;
}

/** Sliders rather than a gear: this configures one workspace, not the app. */
export function WorkspaceIcon() {
  return <ShellIcon icon={Settings2} />;
}

export function SplitViewIcon() {
  return <ShellIcon icon={PanelLeft} size={16} />;
}

export function SearchIcon() {
  return <ShellIcon icon={Search} />;
}

/** Reference passages from a knowledge catalog. */
export function KnowledgeIcon() {
  return <ShellIcon icon={BookOpen} />;
}

/** AI output states a detail no source shows. */
export function UnsourcedFactsIcon() {
  return <ShellIcon icon={TriangleAlert} />;
}

/** Every checkable detail in AI output appears in a source. */
export function SourcedFactsIcon() {
  return <ShellIcon icon={CircleCheck} />;
}

export function FilesIcon() {
  return <ShellIcon icon={FolderTree} />;
}

export function BackupIcon() {
  return <ShellIcon icon={Download} />;
}

/**
 * The X inside every `.db-close-button`. A drawn glyph rather than the `×`
 * character, which sat low and off-center in the UI font. Sized at exactly
 * 1em so the button's `font-size` sets it, and a step heavier than the shell's
 * outlines, as the platform close marks are.
 */
export function CloseIcon() {
  return <ShellIcon icon={X} size="1em" strokeWidth={2.25} />;
}

/** Step back or forward through a sequence, such as a deck's slides. */
export function PreviousIcon() {
  return <ShellIcon icon={ChevronLeft} />;
}

export function NextIcon() {
  return <ShellIcon icon={ChevronRight} />;
}
