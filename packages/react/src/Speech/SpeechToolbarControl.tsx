/**
 * Speech in the editor toolbar: read the document (or the selection) aloud,
 * with a compact transport while it plays. Dictation's microphone button is
 * Squisq's own; this control only bridges the native menu to it.
 *
 * Rendered inside `EditorShell`'s toolbar slot, so it reads the live document
 * and selection from the editor context.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import {
  hostSupports,
  maybeGetDocBlocksHost,
  type DocBlocksHostSpeechAPI,
} from '@bendyline/docblocks/host';
import { useMenuKeyboard } from '../components/useMenuKeyboard.js';
import { GenerateNarrationDialog } from './GenerateNarrationDialog.js';
import { useReadAloud, type ReadAloud } from './useReadAloud.js';
import { useSpeechStatus } from './useSpeechStatus.js';

export interface SpeechToolbarControlProps {
  speech: DocBlocksHostSpeechAPI;
  /** Open the host's model setup (Settings → Speech). */
  onOpenSettings: () => void;
  /** Reading aloud never edits; generating narration does. */
  readOnly?: boolean;
}

/**
 * Native menu → editor. The shell's own menu handler lives outside the editor
 * provider, so the speech commands are handled here, where the document and
 * Squisq's dictation control are in reach.
 */
function useSpeechMenuCommands(readAloud: ReadAloud | null, readCurrent: () => void): void {
  const { dictation } = useEditorContext();
  const latest = useRef({ dictation, readAloud, readCurrent });
  latest.current = { dictation, readAloud, readCurrent };
  useEffect(() => {
    const host = maybeGetDocBlocksHost();
    if (!hostSupports('menuCommands') || !host?.onMenuCommand) return;
    return host.onMenuCommand((command) => {
      const { dictation: control, readAloud: reader, readCurrent: read } = latest.current;
      if (command === 'edit:toggleDictation') control?.toggle();
      if (command === 'edit:readAloud' && reader) {
        if (reader.state.phase === 'idle' || reader.state.phase === 'error') read();
        else reader.stop();
      }
    });
  }, []);
}

/** The menu bridge alone, for a host that can dictate but not read aloud. */
export function SpeechMenuBridge() {
  useSpeechMenuCommands(null, () => undefined);
  return null;
}

export function SpeechToolbarControl({
  speech,
  onOpenSettings,
  readOnly = false,
}: SpeechToolbarControlProps) {
  const { editorMode, getSelection, markdownSource, selectionVersion, activeView } =
    useEditorContext();
  const status = useSpeechStatus(speech);
  const readAloud = useReadAloud(speech);
  const [menuOpen, setMenuOpen] = useState(false);
  const [narrationOpen, setNarrationOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { menuRef, triggerRef, handleMenuKeyDown, handleTriggerKeyDown, closeMenu } =
    useMenuKeyboard(menuOpen, setMenuOpen);
  const sourceRef = useRef(markdownSource);
  sourceRef.current = markdownSource;

  // Reactive invalidators for the imperative selection snapshot.
  void activeView;
  void selectionVersion;
  const selection = getSelection();
  const hasSelection = Boolean(selection && !selection.empty && selection.text.trim());

  const readCurrent = () => {
    const current = getSelection();
    const text =
      current && !current.empty && current.text.trim() ? current.text : sourceRef.current;
    readAloud.start(text);
  };
  useSpeechMenuCommands(readAloud, readCurrent);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  if (editorMode !== 'markdown' || !speech.synthesize) return null;

  const ttsReady = status?.tts.state === 'ready';
  const { state } = readAloud;
  const active = state.phase === 'loading' || state.phase === 'reading';

  return (
    <div className="db-toolbar-menu db-speech-toolbar" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`squisq-toolbar-button${active ? ' squisq-toolbar-button--active' : ''}`}
        onClick={() => setMenuOpen((open) => !open)}
        onKeyDown={handleTriggerKeyDown}
        aria-label="Speech"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-tooltip="Speech"
      >
        <SpeakerGlyph />
      </button>

      {active && (
        <div className="db-speech-transport" role="group" aria-label="Reading aloud">
          {state.phase === 'reading' && state.playing ? (
            <button
              type="button"
              className="squisq-toolbar-button"
              aria-label="Pause reading"
              data-tooltip="Pause"
              onClick={() => readAloud.pause()}
            >
              <PauseGlyph />
            </button>
          ) : (
            <button
              type="button"
              className="squisq-toolbar-button"
              aria-label="Resume reading"
              data-tooltip="Resume"
              disabled={state.phase !== 'reading'}
              onClick={() => readAloud.resume()}
            >
              <PlayGlyph />
            </button>
          )}
          <button
            type="button"
            className="squisq-toolbar-button"
            aria-label="Stop reading"
            data-tooltip="Stop"
            onClick={() => readAloud.stop()}
          >
            <StopGlyph />
          </button>
          <span className="db-speech-transport-label" role="status" aria-live="polite">
            {state.phase === 'loading'
              ? 'Preparing voice…'
              : state.waiting
                ? 'Generating…'
                : `${state.segment + 1} / ${state.segments}`}
          </span>
        </div>
      )}

      {menuOpen && (
        <div
          ref={menuRef}
          className="db-toolbar-menu-dropdown db-speech-toolbar-menu"
          role="menu"
          aria-label="Speech"
          onKeyDown={handleMenuKeyDown}
        >
          {status && !ttsReady && (
            <div className="db-ai-toolbar-status" role="status">
              {status.tts.reason ?? 'Narration is not ready.'}
            </div>
          )}
          {active ? (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="db-toolbar-menu-item"
              onClick={() => {
                closeMenu(false);
                readAloud.stop();
              }}
            >
              Stop reading
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="db-toolbar-menu-item"
              disabled={!ttsReady}
              onClick={() => {
                closeMenu(false);
                readCurrent();
              }}
            >
              {hasSelection ? 'Read selection aloud' : 'Read aloud'}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="db-toolbar-menu-item"
            disabled={!ttsReady || readOnly}
            onClick={() => {
              closeMenu(false);
              setNarrationOpen(true);
            }}
          >
            Generate narration…
          </button>
          {status && status.tts.state === 'download-required' && (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="db-toolbar-menu-item"
              onClick={() => {
                closeMenu(false);
                onOpenSettings();
              }}
            >
              Download voices…
            </button>
          )}
          {state.phase === 'error' && (
            <div className="db-ai-toolbar-status db-settings-ai-error" role="alert">
              {state.message}
            </div>
          )}
        </div>
      )}
      {narrationOpen && (
        <GenerateNarrationDialog speech={speech} onClose={() => setNarrationOpen(false)} />
      )}
    </div>
  );
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 18 18"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function SpeakerGlyph() {
  return (
    <Glyph>
      <path d="M3 7h2.5L9 4v10l-3.5-3H3z" />
      <path d="M11.5 6.5a3.5 3.5 0 0 1 0 5" />
      <path d="M13.5 4.5a6.4 6.4 0 0 1 0 9" />
    </Glyph>
  );
}

function PlayGlyph() {
  return (
    <Glyph>
      <path d="M6 4.5v9l7-4.5z" />
    </Glyph>
  );
}

function PauseGlyph() {
  return (
    <Glyph>
      <path d="M6.5 4.5v9M11.5 4.5v9" />
    </Glyph>
  );
}

function StopGlyph() {
  return (
    <Glyph>
      <rect x="5" y="5" width="8" height="8" rx="1" />
    </Glyph>
  );
}
