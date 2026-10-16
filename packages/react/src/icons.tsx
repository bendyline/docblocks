/**
 * DocBlocks shell icons: Lucide outlines, one family at one stroke weight, so
 * the shell's glyphs match each other and Squisq's toolbar. Each glyph sizes
 * from its control's `font-size`, as the webfont glyphs it replaced did, so the
 * existing button rules keep working. Controls provide the accessible name, so
 * the glyphs themselves stay decorative.
 */

import {
  ArrowDownAZ,
  Clock,
  Download,
  Ellipsis,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  PanelLeft,
  Pin,
  Search,
  Settings2,
  type LucideIcon,
} from 'lucide-react';

/** Slightly over 1em: Lucide draws inside a 2px margin on its 24px grid. */
const ICON_SIZE = '1.15em';
/** 1.75 on the 24px grid renders as a ~1px line at the shell's 13–16px sizes. */
const STROKE_WIDTH = 1.75;

function ShellIcon({ icon: Icon, size = ICON_SIZE }: { icon: LucideIcon; size?: string | number }) {
  return <Icon size={size} strokeWidth={STROKE_WIDTH} aria-hidden="true" focusable="false" />;
}

export function NewFileIcon() {
  return <ShellIcon icon={FilePlus} />;
}

export function NewFolderIcon() {
  return <ShellIcon icon={FolderPlus} />;
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

export function FilesIcon() {
  return <ShellIcon icon={FolderTree} />;
}

export function BackupIcon() {
  return <ShellIcon icon={Download} />;
}
