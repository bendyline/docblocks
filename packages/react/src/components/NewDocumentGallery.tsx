/**
 * NewDocumentGallery — how every new document starts: pick a type from the
 * row of chips, then a starter from the gallery. A card creates the document
 * at once; it is named in the toolbar's title field after it opens, so this
 * dialog never asks for a name.
 *
 * It replaced a dialog that asked for a name and a type and then opened an
 * empty page, so starting anything but a blank document meant knowing what
 * to type.
 *
 * Every starter keeps its place whatever the type: one that does not suit
 * the type is dimmed rather than removed. Removing them shrank the centred
 * dialog, which moved the type chips out from under the pointer.
 */

import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChipRadioGroup } from './ChipRadioGroup.js';
import { Dialog } from './Dialog.js';
import { newFileFormatHint, type NewFileFormat } from '../FileExplorer/new-file-formats.js';
import {
  NEW_DOCUMENT_TEMPLATES,
  NEW_FILE_FORMAT_CHOICES,
  templatesForFormat,
  type NewDocumentTemplate,
  type NewDocumentTemplateId,
} from '../DocBlocksShell/new-document-templates.js';

export interface NewDocumentGalleryChoice {
  template: NewDocumentTemplate;
  format: NewFileFormat;
}

export interface NewDocumentGalleryProps {
  /** Called exactly once with the choice, or `null` on cancel. */
  onSettle: (choice: NewDocumentGalleryChoice | null) => void;
  /** The type selected when the gallery opens. Defaults to Markdown. */
  initialFormat?: NewFileFormat;
  /** The folder the document goes in, when it is not the workspace's top level. */
  folder?: string | null;
}

const MARKDOWN_HINT = 'A plain .md file that any app can open.';
/** Short enough for one line, so the dialog keeps its height on every type. */
const EXCEL_HINT = 'Each save updates the Excel workbook, which keeps only tables.';

export function NewDocumentGallery({
  onSettle,
  initialFormat = 'markdown',
  folder = null,
}: NewDocumentGalleryProps) {
  const [format, setFormat] = useState<NewFileFormat>(initialFormat);
  const firstCardRef = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const offered = useMemo(
    () => new Set(templatesForFormat(format).map((template) => template.id)),
    [format],
  );
  const hint = format === 'xlsx' ? EXCEL_HINT : (newFileFormatHint(format) ?? MARKDOWN_HINT);

  return (
    <Dialog
      title="New document"
      size="wide"
      onClose={() => onSettle(null)}
      initialFocusRef={firstCardRef}
      className="db-new-document-gallery"
      footer={
        <button type="button" className="db-git-secondary-btn" onClick={() => onSettle(null)}>
          Cancel
        </button>
      }
    >
      {folder && (
        <p className="db-new-document-gallery-folder">
          In <strong>{folder.replace(/^\/+/, '')}</strong>
        </p>
      )}
      <div className="db-new-document-gallery-type">
        <ChipRadioGroup
          name="Type"
          value={format}
          options={NEW_FILE_FORMAT_CHOICES}
          onChange={setFormat}
        />
        <p id={hintId} className="db-new-document-gallery-hint">
          {hint}
        </p>
      </div>
      <ul className="db-new-document-gallery-grid" aria-label="Start from">
        {NEW_DOCUMENT_TEMPLATES.map((template, index) => {
          const descriptionId = `${hintId}-${template.id}`;
          const available = offered.has(template.id);
          return (
            <li key={template.id}>
              <button
                ref={index === 0 ? firstCardRef : undefined}
                type="button"
                className="db-new-document-card"
                aria-label={template.label}
                // An unavailable card is described by the hint, which says why.
                aria-describedby={available ? descriptionId : `${descriptionId} ${hintId}`}
                disabled={!available}
                onClick={() => onSettle({ template, format })}
              >
                <TemplateThumbnail id={template.id} />
                <span className="db-new-document-card-label" aria-hidden="true">
                  {template.label}
                </span>
                <span id={descriptionId} className="db-new-document-card-description">
                  {template.description}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}

/* ── Thumbnails ────────────────────────────────────────────────────────── */

const ink = 'db-template-thumb-ink';
const accent = 'db-template-thumb-accent';

/** A text line on the page. */
function Line({ x = 20, y, width }: { x?: number; y: number; width: number }) {
  return <rect className={ink} x={x} y={y} width={width} height={2.5} rx={1.25} />;
}

/** The heading every document starts with. */
function Heading({ x = 20, y = 13, width = 34 }: { x?: number; y?: number; width?: number }) {
  return <rect className={accent} x={x} y={y} width={width} height={5} rx={1.5} />;
}

function Page({ children }: { children?: ReactNode }) {
  return (
    <>
      <rect className="db-template-thumb-page" x={12} y={4} width={72} height={64} rx={3} />
      {children}
    </>
  );
}

function thumbnailBody(id: NewDocumentTemplateId) {
  switch (id) {
    case 'blank':
      return (
        <Page>
          <Heading />
          <rect className={accent} x={20} y={23} width={1.2} height={6} />
        </Page>
      );
    case 'plan':
      return (
        <Page>
          <Heading />
          <Line y={23} width={52} />
          <Line y={28} width={40} />
          {[37, 45, 53].map((y) => (
            <g key={y}>
              <rect
                className="db-template-thumb-box"
                x={20}
                y={y - 1.5}
                width={5}
                height={5}
                rx={1}
              />
              <Line x={28} y={y} width={y === 45 ? 26 : 34} />
            </g>
          ))}
        </Page>
      );
    case 'report':
      return (
        <Page>
          <Heading />
          <Line y={23} width={52} />
          <Line y={28} width={44} />
          {[
            [22, 10],
            [32, 14],
            [42, 20],
            [52, 24],
          ].map(([x, height]) => (
            <rect
              key={x}
              className={accent}
              x={x}
              y={60 - height}
              width={7}
              height={height}
              rx={1}
            />
          ))}
          <rect className={ink} x={20} y={60} width={44} height={1.2} />
        </Page>
      );
    case 'meeting-notes':
      return (
        <Page>
          <Heading width={40} />
          {[25, 33, 41, 49, 57].map((y, i) => (
            <g key={y}>
              <circle className={accent} cx={22} cy={y + 1.25} r={1.6} />
              <Line x={27} y={y} width={[40, 30, 36, 26, 33][i]!} />
            </g>
          ))}
        </Page>
      );
    case 'lesson':
      return (
        <Page>
          <Heading />
          <Line y={23} width={50} />
          {[34, 44, 54].map((y, i) => (
            <g key={y}>
              <circle className={accent} cx={23} cy={y + 1.25} r={3.2} />
              <Line x={30} y={y} width={[30, 36, 24][i]!} />
            </g>
          ))}
        </Page>
      );
    case 'resume':
      return (
        <Page>
          <Heading x={31} width={34} />
          <Line x={30} y={22} width={36} />
          <rect className={ink} x={20} y={28} width={56} height={0.8} />
          <rect className={accent} x={20} y={33} width={16} height={3} rx={1} />
          <Line y={39} width={48} />
          <Line y={44} width={40} />
          <rect className={accent} x={20} y={51} width={16} height={3} rx={1} />
          <Line y={57} width={44} />
        </Page>
      );
    case 'presentation':
      return (
        <>
          <rect className="db-template-thumb-slide" x={6} y={12} width={84} height={48} rx={3} />
          <rect
            className="db-template-thumb-slide-title"
            x={24}
            y={28}
            width={48}
            height={6}
            rx={1.5}
          />
          <rect
            className="db-template-thumb-slide-text"
            x={32}
            y={39}
            width={32}
            height={2.5}
            rx={1.25}
          />
          <rect className="db-template-thumb-page" x={14} y={62} width={14} height={8} rx={1.5} />
          <rect className="db-template-thumb-page" x={31} y={62} width={14} height={8} rx={1.5} />
          <rect className="db-template-thumb-page" x={48} y={62} width={14} height={8} rx={1.5} />
        </>
      );
    case 'budget':
      return (
        <Page>
          <Heading width={26} />
          {[24, 31, 38, 45].map((y) => (
            <g key={y}>
              <rect className="db-template-thumb-cell" x={20} y={y} width={22} height={6} />
              <rect className="db-template-thumb-cell" x={42} y={y} width={12} height={6} />
            </g>
          ))}
          <circle className={ink} cx={66} cy={56} r={8} />
          <path className={accent} d="M66 56 L66 48 A8 8 0 0 1 73.6 58.5 Z" />
        </Page>
      );
  }
}

/** A drawing of what the template holds; the card's label says it in words. */
function TemplateThumbnail({ id }: { id: NewDocumentTemplateId }) {
  return (
    <svg className="db-template-thumb" viewBox="0 0 96 72" aria-hidden="true" focusable="false">
      {thumbnailBody(id)}
    </svg>
  );
}
