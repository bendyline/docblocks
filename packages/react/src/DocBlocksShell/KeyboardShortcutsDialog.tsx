/**
 * KeyboardShortcutsDialog — the keyboard-shortcut sheet, opened from the app
 * menu's Help group, F1, or `?`.
 */

import React, { Fragment, useId, useMemo } from 'react';
import { getHostEnvironment } from '@bendyline/docblocks/host';
import { Dialog } from '../components/Dialog.js';
import { isApplePlatform } from './keyboard-shortcuts.js';
import { displayKeys, shortcutSheet, spokenChord } from './shortcut-sheet.js';

export interface KeyboardShortcutsDialogProps {
  onClose: () => void;
}

export function KeyboardShortcutsDialog({ onClose }: KeyboardShortcutsDialogProps) {
  const idPrefix = useId();
  const apple = isApplePlatform();
  // A browser tab keeps chords such as Ctrl+N for itself; a native host
  // (desktop, mobile) passes every key to the app.
  const sections = useMemo(() => shortcutSheet({ nativeHost: getHostEnvironment() !== null }), []);

  return (
    <Dialog
      title="Keyboard shortcuts"
      onClose={onClose}
      size="wide"
      className="db-shortcuts-dialog"
    >
      {/* Focusable so the arrow keys can scroll the sheet on short windows:
          it holds no controls of its own. */}
      <div className="db-shortcuts" role="region" aria-label="Shortcut list" tabIndex={0}>
        {sections.map((section, sectionIndex) => {
          const headingId = `${idPrefix}-${sectionIndex}`;
          return (
            <section
              key={section.title}
              className="db-shortcuts-section"
              aria-labelledby={headingId}
            >
              <h3 id={headingId} className="db-shortcuts-heading">
                {section.title}
              </h3>
              <dl className="db-shortcuts-list">
                {section.entries.map((entry) => (
                  <div key={entry.action} className="db-shortcuts-row">
                    <dt className="db-shortcuts-action">{entry.action}</dt>
                    <dd className="db-shortcuts-keys">
                      {entry.chords.map((chord, chordIndex) => (
                        <Fragment key={chord.join('+')}>
                          {chordIndex > 0 && <span className="db-shortcuts-or">or</span>}
                          <span className="db-shortcuts-chord">
                            <span aria-hidden="true">
                              {displayKeys(chord, apple).map((key) => (
                                <kbd key={key}>{key}</kbd>
                              ))}
                            </span>
                            <span className="db-visually-hidden">{spokenChord(chord, apple)}</span>
                          </span>
                        </Fragment>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}
