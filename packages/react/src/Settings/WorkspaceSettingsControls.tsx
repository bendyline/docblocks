/**
 * Controls for one workspace's `.docblocks/workspace.json`, shared by the
 * shell's Workspace settings dialog and the VS Code webview's Settings dialog.
 *
 * The controls edit a draft `WorkspaceSettings`; the host diffs it against
 * the file it read and saves only the changed fields. Absent fields mean
 * "inherit" (version history) or "off" (catalog outputs), so a control that is
 * cleared removes its field rather than writing a default.
 */

import { useEffect, useId, useState } from 'react';
import {
  DEFAULT_CATALOG_HTML_PATH,
  DEFAULT_CATALOG_JSON_PATH,
  DEFAULT_CATALOG_TITLE,
  type CatalogJsonContent,
  type CatalogSortOrder,
  type WorkspaceCatalogHtmlSettings,
  type WorkspaceCatalogJsonSettings,
  type WorkspaceCatalogSettings,
  type WorkspaceSettings,
} from '@bendyline/docblocks/workspace-settings';

export interface WorkspaceSettingsThemeOption {
  readonly id: string;
  readonly name: string;
}

export interface WorkspaceCatalogStatusView {
  readonly message: string;
  readonly tone: 'info' | 'warning';
}

export interface WorkspaceSettingsControlsProps {
  value: WorkspaceSettings;
  onChange: (next: WorkspaceSettings) => void;
  themes: readonly WorkspaceSettingsThemeOption[];
  disabled?: boolean;
  /**
   * Present when the host keeps version history. `inheritLabel` describes
   * what "use the app default" currently means for this workspace.
   */
  versionHistory?: { readonly inheritLabel: string };
  catalogStatus?: WorkspaceCatalogStatusView | null;
  /** Rebuild the catalog now. Omit when the host cannot. */
  onRegenerate?: () => void;
  regenerating?: boolean;
}

type Section<T> = T | undefined;

function compactObject<T extends object>(value: T): Section<T> {
  const entries = Object.entries(value).filter(([, field]) => field !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as T) : undefined;
}

function withSection<K extends 'documents' | 'versionHistory' | 'catalog'>(
  settings: WorkspaceSettings,
  key: K,
  section: WorkspaceSettings[K],
): WorkspaceSettings {
  const next: Record<string, unknown> = { ...settings };
  if (section === undefined) delete next[key];
  else next[key] = section;
  return next as unknown as WorkspaceSettings;
}

function withCatalog(
  settings: WorkspaceSettings,
  patch: Partial<WorkspaceCatalogSettings>,
): WorkspaceSettings {
  return withSection(
    settings,
    'catalog',
    compactObject<WorkspaceCatalogSettings>({ ...(settings.catalog ?? {}), ...patch }),
  );
}

function withCatalogHtml(
  settings: WorkspaceSettings,
  patch: Partial<WorkspaceCatalogHtmlSettings>,
): WorkspaceSettings {
  return withCatalog(settings, {
    html: compactObject<WorkspaceCatalogHtmlSettings>({
      ...(settings.catalog?.html ?? {}),
      ...patch,
    }),
  });
}

function withCatalogJson(
  settings: WorkspaceSettings,
  patch: Partial<WorkspaceCatalogJsonSettings>,
): WorkspaceSettings {
  return withCatalog(settings, {
    json: compactObject<WorkspaceCatalogJsonSettings>({
      ...(settings.catalog?.json ?? {}),
      ...patch,
    }),
  });
}

function optionalText(value: string): string | undefined {
  return value.trim() ? value : undefined;
}

export function WorkspaceSettingsControls({
  value,
  onChange,
  themes,
  disabled = false,
  versionHistory,
  catalogStatus,
  onRegenerate,
  regenerating = false,
}: WorkspaceSettingsControlsProps) {
  const id = useId();
  const htmlEnabled = value.catalog?.html?.enabled === true;
  const jsonEnabled = value.catalog?.json?.enabled === true;
  const catalogEnabled = htmlEnabled || jsonEnabled;
  const excludeText = (value.catalog?.exclude ?? []).join('\n');
  const [excludeDraft, setExcludeDraft] = useState(excludeText);
  useEffect(() => {
    // Adopt external changes (a re-read file) without fighting the user's typing.
    setExcludeDraft((current) =>
      current
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n') === excludeText
        ? current
        : excludeText,
    );
  }, [excludeText]);

  const versioning =
    value.versionHistory?.enabled === undefined
      ? 'inherit'
      : value.versionHistory.enabled
        ? 'on'
        : 'off';

  const themeSelect = (
    selectId: string,
    selected: string | undefined,
    emptyLabel: string,
    onSelect: (themeId: string | undefined) => void,
  ) => (
    <select
      id={selectId}
      className="db-settings-select-input"
      value={selected ?? ''}
      disabled={disabled}
      onChange={(event) => onSelect(event.currentTarget.value || undefined)}
    >
      <option value="">{emptyLabel}</option>
      {themes.map((theme) => (
        <option key={theme.id} value={theme.id}>
          {theme.name}
        </option>
      ))}
      {selected && !themes.some((theme) => theme.id === selected) && (
        <option value={selected}>{selected} (not installed)</option>
      )}
    </select>
  );

  return (
    <div className="db-workspace-settings">
      <fieldset className="db-settings-fieldset" disabled={disabled}>
        <legend className="db-settings-legend">Documents</legend>
        <div className="db-settings-select">
          <label className="db-settings-select-header" htmlFor={`${id}-theme`}>
            Default theme
          </label>
          {themeSelect(`${id}-theme`, value.documents?.defaultTheme, 'Standard', (themeId) =>
            onChange(
              withSection(
                value,
                'documents',
                compactObject({ ...(value.documents ?? {}), defaultTheme: themeId }),
              ),
            ),
          )}
        </div>
        <p className="db-settings-hint">
          Used by documents in this folder that don&rsquo;t choose a theme of their own. Web pages
          pick up a change the next time they&rsquo;re saved.
        </p>
      </fieldset>

      <fieldset className="db-settings-fieldset" disabled={disabled}>
        <legend className="db-settings-legend">Catalog</legend>
        <p className="db-settings-hint">
          Keep a list of every document in this folder up to date as you save. DocBlocks only ever
          replaces files it created.
        </p>

        <label className="db-settings-checkbox">
          <input
            type="checkbox"
            checked={htmlEnabled}
            onChange={(event) =>
              onChange(
                withCatalogHtml(value, { enabled: event.currentTarget.checked ? true : undefined }),
              )
            }
          />
          Catalog page
        </label>
        {htmlEnabled && (
          <div className="db-settings-subfields">
            <div className="db-settings-text">
              <label htmlFor={`${id}-html-path`}>Page file</label>
              <input
                id={`${id}-html-path`}
                className="db-settings-text-input"
                type="text"
                spellCheck={false}
                placeholder={DEFAULT_CATALOG_HTML_PATH}
                value={value.catalog?.html?.path ?? ''}
                onChange={(event) =>
                  onChange(
                    withCatalogHtml(value, { path: optionalText(event.currentTarget.value) }),
                  )
                }
              />
            </div>
            <div className="db-settings-text">
              <label htmlFor={`${id}-html-theme`}>Page theme</label>
              {themeSelect(
                `${id}-html-theme`,
                value.catalog?.html?.theme,
                'Same as default theme',
                (themeId) => onChange(withCatalogHtml(value, { theme: themeId })),
              )}
            </div>
          </div>
        )}

        <label className="db-settings-checkbox">
          <input
            type="checkbox"
            checked={jsonEnabled}
            onChange={(event) =>
              onChange(
                withCatalogJson(value, { enabled: event.currentTarget.checked ? true : undefined }),
              )
            }
          />
          Catalog data (JSON)
        </label>
        {jsonEnabled && (
          <div className="db-settings-subfields">
            <div className="db-settings-text">
              <label htmlFor={`${id}-json-path`}>Data file</label>
              <input
                id={`${id}-json-path`}
                className="db-settings-text-input"
                type="text"
                spellCheck={false}
                placeholder={DEFAULT_CATALOG_JSON_PATH}
                value={value.catalog?.json?.path ?? ''}
                onChange={(event) =>
                  onChange(
                    withCatalogJson(value, { path: optionalText(event.currentTarget.value) }),
                  )
                }
              />
            </div>
            <div
              className="db-settings-radio-row"
              role="radiogroup"
              aria-label="Catalog data content"
            >
              {(
                [
                  ['metadata', 'Titles, descriptions and outlines'],
                  ['markdown', 'Also include each document’s Markdown'],
                ] as const satisfies ReadonlyArray<readonly [CatalogJsonContent, string]>
              ).map(([content, label]) => (
                <label key={content} className="db-settings-radio db-settings-radio--inline">
                  <input
                    type="radio"
                    name={`${id}-json-content`}
                    checked={(value.catalog?.json?.content ?? 'metadata') === content}
                    onChange={() =>
                      onChange(
                        withCatalogJson(value, {
                          content: content === 'metadata' ? undefined : content,
                        }),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        )}

        {catalogEnabled && (
          <div className="db-settings-subfields">
            <div className="db-settings-text">
              <label htmlFor={`${id}-title`}>Title</label>
              <input
                id={`${id}-title`}
                className="db-settings-text-input"
                type="text"
                placeholder={DEFAULT_CATALOG_TITLE}
                value={value.catalog?.title ?? ''}
                onChange={(event) =>
                  onChange(withCatalog(value, { title: optionalText(event.currentTarget.value) }))
                }
              />
            </div>
            <div className="db-settings-text">
              <label htmlFor={`${id}-sort`}>Order</label>
              <select
                id={`${id}-sort`}
                className="db-settings-select-input"
                value={value.catalog?.sort ?? 'title'}
                onChange={(event) => {
                  const sort = event.currentTarget.value as CatalogSortOrder;
                  onChange(withCatalog(value, { sort: sort === 'title' ? undefined : sort }));
                }}
              >
                <option value="title">By title</option>
                <option value="date">Newest first (frontmatter date)</option>
                <option value="path">By file path</option>
              </select>
            </div>
            <div className="db-settings-text">
              <label htmlFor={`${id}-exclude`}>Leave out</label>
              <textarea
                id={`${id}-exclude`}
                className="db-settings-text-input db-settings-textarea"
                rows={2}
                spellCheck={false}
                placeholder="drafts/"
                value={excludeDraft}
                onChange={(event) => {
                  const text = event.currentTarget.value;
                  setExcludeDraft(text);
                  const exclude = text
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean);
                  onChange(
                    withCatalog(value, { exclude: exclude.length > 0 ? exclude : undefined }),
                  );
                }}
              />
            </div>
            <p className="db-settings-hint">One folder or file per line.</p>
            {(catalogStatus || onRegenerate) && (
              <div className="db-settings-status-row">
                {catalogStatus && (
                  <p
                    className={`db-settings-status db-settings-status--${catalogStatus.tone}`}
                    role="status"
                  >
                    {catalogStatus.message}
                  </p>
                )}
                {onRegenerate && (
                  <button
                    type="button"
                    className="db-git-secondary-btn"
                    disabled={regenerating}
                    onClick={onRegenerate}
                  >
                    {regenerating ? 'Updating…' : 'Update now'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </fieldset>

      {versionHistory && (
        <fieldset className="db-settings-fieldset" disabled={disabled}>
          <legend className="db-settings-legend">Version history</legend>
          <p className="db-settings-hint">
            Keeps prior revisions in <code>&lt;name&gt;_files/.versions/</code> for documents in
            this folder.
          </p>
          {(
            [
              ['inherit', versionHistory.inheritLabel],
              ['on', 'On for this folder'],
              ['off', 'Off for this folder'],
            ] as const
          ).map(([option, label]) => (
            <label key={option} className="db-settings-radio">
              <input
                type="radio"
                name={`${id}-versioning`}
                value={option}
                checked={versioning === option}
                onChange={() =>
                  onChange(
                    withSection(
                      value,
                      'versionHistory',
                      compactObject({
                        ...(value.versionHistory ?? {}),
                        enabled: option === 'inherit' ? undefined : option === 'on',
                      }),
                    ),
                  )
                }
              />
              {label}
            </label>
          ))}
          <div className="db-settings-text">
            <label htmlFor={`${id}-keep`}>Revisions to keep per document</label>
            <input
              id={`${id}-keep`}
              className="db-settings-text-input db-settings-number-input"
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              step={1}
              placeholder="50"
              value={value.versionHistory?.keep ?? ''}
              onChange={(event) => {
                const raw = event.currentTarget.value;
                const keep = raw === '' ? undefined : Number(raw);
                onChange(
                  withSection(
                    value,
                    'versionHistory',
                    compactObject({ ...(value.versionHistory ?? {}), keep }),
                  ),
                );
              }}
            />
          </div>
        </fieldset>
      )}
    </div>
  );
}
