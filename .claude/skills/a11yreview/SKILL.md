---
name: a11yreview
description: Run accessibility audits (WCAG 2.1 AA) against the DocBlocks UI surfaces — the site shell, the Electron desktop renderer, and the VS Code custom editor webview — covering DocBlocksShell, FileExplorer, WorkspacePicker, AppMenu, Export dialog, and Setup pane. Identify violations, fix common issues directly, and produce an accessibility report. Use when asked to review accessibility, audit for a11y, or check WCAG compliance.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# Accessibility Review Skill

You are an accessibility expert reviewing DocBlocks for WCAG 2.1 AA compliance. DocBlocks ships the same React shell (`<DocBlocksShell>` from `@bendyline/docblocks-react`) to three rendering surfaces:

1. **Site** (web) — `packages/site/`, served at `localhost:5220` for dev
2. **Desktop** (Electron renderer) — `packages/desktop/renderer/`, the same React tree plus a `DocBlocksHostAPI` injected via contextBridge
3. **VS Code webview** — `packages/vscode/webview/`, a separate `VscodeEditor.tsx` that wraps Squisq/Monaco for \*.md files inside VS Code's custom editor surface

A11y matters because DocBlocks is a document editor, and document editing is one of the surfaces with the highest screen-reader and keyboard usage in the world. People who write a lot rely on AT to do it.

You run automated scans where you can, examine the rendered UI, fix common issues directly via the Edit tool, and produce an actionable report.

**Your north star:** Can every user — regardless of ability, assistive technology, or input method — fully open a workspace, browse files, edit a document, switch themes, configure preferences, and export their work without barriers?

## When This Skill Runs

- After shipping a new view, modal, dialog, or component in `packages/react/src/`
- After changing the VS Code custom editor webview (`packages/vscode/webview/src/`)
- After changing the Electron renderer (`packages/desktop/renderer/`)
- Before a release to catch a11y regressions
- When the user asks for an a11y audit or WCAG check
- Periodically to maintain compliance

## Prerequisites

DocBlocks doesn't currently bundle `@axe-core/playwright`. The audit can still proceed using:

- Existing Playwright specs (root `e2e/app.spec.ts`, desktop `app-lifecycle.spec.ts`, vscode `markdown-editor-smoke.spec.ts`) to drive the UI through key flows
- Manual ARIA / semantic-HTML inspection via Read + Grep across `packages/react/src/`, `packages/vscode/webview/src/`, and `packages/desktop/renderer/`
- Optional: install `@axe-core/playwright` for automated scans on first run of this skill

```bash
# Check whether axe is installed at the root (Playwright is a root devDep)
ls node_modules/@axe-core/playwright/dist/index.js 2>/dev/null && echo "axe present" || echo "axe NOT installed — propose adding it"

# Confirm fresh builds — e2e requires them
ls packages/react/dist 2>/dev/null && echo "react built" || echo "needs npm run build:react"
ls packages/site/dist 2>/dev/null && echo "site built (optional for dev e2e)"
```

If axe isn't installed, propose adding it before scanning:

```bash
npm install -D @axe-core/playwright
```

The skill can run a manual review without axe (ARIA/semantic inspection + Playwright keyboard traversal) but axe automation is the gold-standard first pass.

**Important note on Squisq**: the actual document editor is **Squisq** (sister project in `..\qualla`). Editor-internal a11y (caret rendering, selection announcements, toolbar focus traps, formatting menus inside the document) is Squisq's responsibility. File issues there rather than monkey-patching from DocBlocks. DocBlocks's responsibility is everything **around** the editor: file explorer, workspace picker, app menu, export dialog, setup pane, and the shell chrome.

---

## Step 1: Establish the UI Surface

Before scanning, internalize what's there. DocBlocks's UI surface area lives across four packages:

```
packages/react/src/                — the canonical component library
  DocBlocksShell/                  — shell layout, theme prop
  FileExplorer/                    — file tree, create/rename/delete UI
    FileExplorer.tsx
    FileTreeNode.tsx
    useFileTree.ts
  WorkspacePicker/                 — workspace dropdown + settings dialog
    WorkspacePicker.tsx
    WorkspaceSettingsButton.tsx
    WorkspaceSettingsDialog.tsx
  AppMenu/                         — top menu bar, About dialog
    AppMenu.tsx
  Export/                          — export pipeline UI
    ExportDialog.tsx
    ExportToolbarControls.tsx
    export-options.ts
  hooks/useAutoSave.ts
  styles/docblocks.css             — global stylesheet (color tokens, focus styles)
  icons.tsx                        — SVG icon components
  fonts/                           — 17 woff2 fonts (font-display matters)

packages/site/src/                 — web surface
  App.tsx                          — mounts <DocBlocksShell theme="auto">

packages/desktop/renderer/         — Electron surface (same React tree + host API)
  App.tsx                          — mounts <DocBlocksShell>
  UpdateStatusBanner.tsx           — auto-updater status banner

packages/vscode/webview/src/       — VS Code custom editor
  main.tsx
  VscodeEditor.tsx                 — wraps Squisq/Monaco for *.md
  monaco-slim.ts
  vscodeApi.ts                     — postMessage bridge
```

High-priority surfaces for accessibility (touched on every session):

- **DocBlocksShell** — primary layout; focus order, landmarks
- **FileExplorer** — keyboard navigation (arrows, Enter, F2 for rename), tree role
- **WorkspacePicker** — combobox / menu semantics, escape handling
- **WorkspaceSettingsDialog** — modal: focus trap, return focus, aria-modal
- **AppMenu** — menubar role, arrow-key navigation between menus
- **ExportDialog** — form labels, error association, primary-action prominence
- **UpdateStatusBanner** — aria-live status updates without focus-stealing
- **VscodeEditor webview** — focus boundary with VS Code's outer chrome, theme reactivity

---

## Step 2: Run an Automated Scan (if axe is installed)

If axe-core is present, write a small Playwright test that runs against the **site** (the easiest target — no Electron, no VS Code chrome around it) and exercises each surface:

1. Boots the site dev server (`npm run dev` on port 5220, or use the existing root `playwright.config.ts` webServer)
2. Visits the loaded shell with a few sample files in place
3. Opens and closes the workspace settings dialog
4. Opens and closes the export dialog
5. Runs `AxeBuilder` against each rendered state
6. Saves screenshots to `test-results/a11y/` for visual cross-check

Suggested location: `e2e/a11y-site.spec.ts` (alongside `e2e/app.spec.ts`). Don't commit it to the long-term test suite without team agreement — accessibility specs are typically worth keeping, but the call belongs to the maintainer.

```bash
# Run from repo root, after the site is buildable
npx playwright test e2e/a11y-site.spec.ts --reporter=list
```

For the **VS Code webview** and **Electron renderer**, automated axe scans are harder (each runs in a non-standard browser context). Consider one of:

- Run axe against `packages/vscode/webview/` via Vite preview on port 3100 (the webview is a pure React app that can render standalone for testing)
- Run axe inside the desktop e2e by injecting the axe script into the running Electron renderer

If axe isn't installed and the user doesn't want it added yet, skip to Step 3 and do a manual review.

## Step 3: Manual Review by Component

Without axe, use Read + Grep to spot common WCAG issues. Walk through these checks per major surface.

### 3.1 Keyboard Navigation

```
# Find divs/spans acting as buttons (need role="button" + onKeyDown + tabIndex={0})
Grep pattern='<(div|span)[^>]*onClick=' glob='packages/react/src/**/*.tsx'
Grep pattern='<(div|span)[^>]*onClick=' glob='packages/vscode/webview/src/**/*.tsx'

# Mouse-only handlers
Grep pattern='onMouse(Down|Up|Enter|Leave)\\s*=' glob='packages/react/src/**/*.tsx'

# tabIndex usage (positive values almost always wrong)
Grep pattern='tabIndex={?[1-9]' glob='packages/**/*.tsx'

# Tree / list keyboard handling — FileExplorer should respond to ArrowUp/Down/Left/Right/Enter/F2
Grep pattern='onKeyDown|onKeyUp|onKeyPress' path=packages/react/src/FileExplorer/
```

Look at each match. Interactive elements should be `<button>` (or `<a href>`), not `<div onClick>`. Tree views (the FileExplorer) should follow ARIA's tree pattern (Arrow keys to move, Enter to activate, F2 to rename), with `role="tree"` on the container, `role="treeitem"` on nodes, `aria-expanded` on expandable nodes, and `aria-level` for nested depth.

### 3.2 ARIA & Semantic HTML

```
# Icon-only buttons missing aria-label
Grep pattern='<button[^>]*>\\s*<(svg|Icon)' glob='packages/react/src/**/*.tsx'
Grep pattern='<button[^>]*>\\s*<(svg|Icon)' glob='packages/vscode/webview/src/**/*.tsx'

# Images without alt
Grep pattern='<img[^>]*src=' glob='packages/**/*.tsx'   # filter to those missing `alt=`

# Form inputs without label / aria-label / aria-labelledby
Grep pattern='<input[^>]*type="(text|search|email|number|password|url)"' glob='packages/**/*.tsx'

# Landmark regions
Grep pattern='<(main|nav|header|footer|aside)\\b' glob='packages/react/src/**/*.tsx'

# Modal / dialog patterns — ensure role="dialog" or <dialog> + aria-modal + focus management
Grep pattern='role="dialog"|<dialog' glob='packages/**/*.tsx'
```

### 3.3 Color Contrast

Read the canonical stylesheet:

```
packages/react/src/styles/docblocks.css
```

Check that text colors against their backgrounds meet **4.5:1** for body text, **3:1** for large text and UI components. Pay particular attention to:

- Workspace picker dropdown items in active / hover / focus states
- File tree nodes (active vs hover vs focus vs selected)
- Disabled / muted button states
- Theme tokens for both light and dark themes (DocBlocksShell accepts `theme="light" | "dark" | "auto"`)
- The UpdateStatusBanner's various states (idle / checking / downloading / ready / error)

### 3.4 Focus Management

Critical patterns:

- **Modals trap focus** — WorkspaceSettingsDialog and ExportDialog should both trap Tab inside the modal until dismissed
- **Modal close returns focus** to the trigger element
- **About dialog** (from AppMenu) — same rules
- **Update banner** — reachable but doesn't steal focus

```
# Find dialog components — verify focus management
Grep pattern='Dialog' glob='packages/react/src/**/*.tsx' output_mode=files_with_matches
```

### 3.5 Screen-Reader Concerns

- **Live regions** for status changes — does UpdateStatusBanner use `aria-live="polite"`?
- **Announce state changes** — autosave success/failure, workspace switched, file created/renamed/deleted
- **Headings hierarchy** — every surface should start with `<h1>`; verify no skipped levels in dialogs
- **Lists are lists** — file tree uses `<ul role="tree">` / `<li role="treeitem">` (or equivalent ARIA structure)

```
Grep pattern='aria-live|role="status"|role="alert"' glob='packages/react/src/**/*.tsx'
```

### 3.6 Motion & Reduced Motion

```
Grep pattern='prefers-reduced-motion' path=packages/react/src/styles/
Grep pattern='transition|animation' path=packages/react/src/styles/
```

The app should respect `@media (prefers-reduced-motion: reduce)` — disable or shorten dialog open/close animations, file-tree expansion animations, theme transition.

### 3.7 VS Code Webview Specifics

The webview is a separate React tree inside VS Code. Specific concerns:

- **Theme**: VS Code can switch theme at runtime (Light/Dark/HC). The webview must respond via postMessage and re-apply colors. Verify `vscodeApi.ts` listens for theme messages and the editor restyles.
- **Focus boundary**: VS Code keyboard shortcuts (Ctrl+Shift+P, Ctrl+P) must remain accessible when focus is inside the webview. Verify no global key handlers swallowing those.
- **High Contrast theme**: VS Code's HC theme uses extreme colors — verify the editor still renders intelligibly (don't override system colors with custom palettes when in HC).
- **Setup pane** (separate webview in the Activity bar): same rules — labels on every input, headings ordered, status text in `aria-live` regions.

### 3.8 Electron Renderer Specifics

- Renderer is the same React tree as site, plus `UpdateStatusBanner` and any host-API-driven UI (workspace picker showing folder paths via `getDocBlocksHost().workspaces`)
- Verify the app menu (native, in `packages/desktop/main/menu.ts`) doesn't duplicate AppMenu items unnecessarily — duplication confuses screen readers ("New… New…")
- Tray menu (`packages/desktop/main/tray.ts`) labels read clearly
- Deep-link handler (`docblocks://`) failure modes — does the renderer announce when a deep-link can't be resolved?

---

## Step 4: Categorize Findings (WCAG Principles)

### Perceivable

- Missing alt text on icons / images
- Insufficient color contrast (especially in light/dark theme parity)
- Missing text alternatives for non-text content (UpdateStatusBanner state conveyed only by color or icon)
- Font sizes / line heights uncomfortable at default scale

### Operable

- Keyboard traps (can't tab out of FileExplorer, ExportDialog, etc.)
- Missing visible focus indicators on custom controls
- Mouse-only interactions (FileTreeNode drag-drop without keyboard alternative)
- File tree not implementing the ARIA tree pattern

### Understandable

- Form inputs without labels (Export dialog, Workspace settings)
- Unclear error messages (e.g., a generic "Export failed" toast)
- Inconsistent navigation between dialogs
- Missing `lang` attribute on `<html>` (site / desktop renderer)

### Robust

- Invalid ARIA attributes
- Duplicate element IDs (especially in trees rendered for large workspaces)
- Missing landmarks (`<main>`, `<nav>`)
- Incorrect ARIA state management (e.g., `aria-expanded` not toggling on tree nodes)

## Step 5: Fix Common Issues

**The #1 goal of this skill is to fix issues, not just report them.**

You have Edit access. Common quick fixes:

### Add `aria-label` to icon-only buttons

```tsx
// Before
<button onClick={openMenu}>
  <MenuIcon />
</button>

// After
<button onClick={openMenu} aria-label="Open menu">
  <MenuIcon />
</button>
```

### Add `alt` to images

```tsx
// Before
<img src={workspace.iconUrl} />

// After
<img src={workspace.iconUrl} alt={`${workspace.name} icon`} />
// Decorative:
<img src={pattern} alt="" role="presentation" />
```

### Use semantic landmarks in DocBlocksShell

```tsx
<header aria-label="Application">{/* AppMenu */}</header>
<nav aria-label="File explorer">{/* FileExplorer */}</nav>
<main aria-label="Document editor">{/* Squisq editor */}</main>
```

### Associate form labels in dialogs

```tsx
// Before
<span>Workspace name</span>
<input value={name} onChange={...} />

// After
<label>
  Workspace name
  <input value={name} onChange={...} />
</label>
```

### Add `aria-live` to UpdateStatusBanner

```tsx
<div role="status" aria-live="polite" aria-atomic="true">
  {status === 'downloading' && `Downloading update… ${percent}%`}
  {status === 'ready' && 'Update ready — restart to apply'}
</div>
```

### Modal focus trap (WorkspaceSettingsDialog, ExportDialog)

Use the native `<dialog>` element with `showModal()` (modern browsers + Electron) or a focus-trap library. Set `aria-modal="true"`, give the dialog `role="dialog"`, label it via `aria-labelledby`, and return focus to the trigger on close.

### Tree role on FileExplorer

```tsx
<ul role="tree" aria-label="Workspace files">
  <li role="treeitem" aria-expanded={expanded} aria-level={depth}>
    {/* node content */}
  </li>
</ul>
```

### After fixing

Re-run the scan (or rerun the e2e suite) to verify your fixes.

```bash
npm test
npm run typecheck
npm run lint
# If axe spec was written:
npx playwright test e2e/a11y-site.spec.ts
```

## Step 6: Produce the Accessibility Report

Write to `reports/a11y-review-YYYYMMDD-HHMM.md` (create `reports/` if missing).

```markdown
# DocBlocks Accessibility Review Report

**Date:** YYYY-MM-DD
**Reviewer:** Claude (AI Accessibility Review)
**Build/Commit:** [git short hash]
**WCAG Target:** 2.1 Level AA
**Surfaces audited:** Site / Desktop renderer / VS Code webview / Setup pane
**Scan method:** axe-core / manual / both

## Compliance Summary

| Principle      | Status                | Details   |
| -------------- | --------------------- | --------- |
| Perceivable    | Pass / Partial / Fail | [summary] |
| Operable       | Pass / Partial / Fail | [summary] |
| Understandable | Pass / Partial / Fail | [summary] |
| Robust         | Pass / Partial / Fail | [summary] |

**Overall:** X of Y rules passing. Z violations found across N surfaces.

## Issues Fixed During This Review

### [Issue title]

- **File:** [path]
- **WCAG criterion:** [e.g., 1.1.1 Non-text Content]
- **What was wrong:** [description]
- **Fix applied:** [what you changed]

## Remaining Violations

### Critical (Must Fix)

#### [Issue title]

- **Where:** [surface / component]
- **WCAG criterion:** [number + name]
- **axe rule:** [rule ID, if from automated scan]
- **Impact:** critical / serious
- **Affected elements:** [selectors]
- **Suggested fix:** [concrete recommendation]

### Serious (Should Fix)

[Same format]

### Moderate (Could Improve)

[Same format]

## Surface-by-Surface Findings

| Surface / Component                       | Issues found | Severity | Fixed? |
| ----------------------------------------- | ------------ | -------- | ------ |
| Site shell                                | ?            | ?        | ?      |
| Desktop renderer                          | ?            | ?        | ?      |
| VS Code custom editor                     | ?            | ?        | ?      |
| VS Code Setup pane                        | ?            | ?        | ?      |
| DocBlocksShell                            | ?            | ?        | ?      |
| FileExplorer                              | ?            | ?        | ?      |
| WorkspacePicker / WorkspaceSettingsDialog | ?            | ?        | ?      |
| AppMenu / About dialog                    | ?            | ?        | ?      |
| ExportDialog / ExportToolbarControls      | ?            | ?        | ?      |
| UpdateStatusBanner                        | ?            | ?        | ?      |

## Screenshots

[Link to key images from test-results/a11y/ with captions]

## Recommendations

1. [Highest-impact recommendation]
2. ...

## Gaps & Limitations

- Screen-reader testing requires manual verification (NVDA on Windows, VoiceOver on macOS, JAWS for thorough coverage)
- Squisq editor internals (caret, selection, formatting toolbar inside the document) are owned upstream — issues there require fixes in ..\qualla, not here
- VS Code webview a11y interacts with VS Code's own chrome — some assessments only meaningful inside a real VS Code instance, not the test webview
- Electron native menus (packages/desktop/main/menu.ts) and tray are OS-rendered — a11y comes from OS-level conformance, not our code
- Color contrast on transparency / glass effects (if any in the dark theme) needs visual judgment
```

## Step 7: Present Results

1. **Lead with the headline number** — "Found 23 violations across 4 surfaces, fixed 15."
2. **Link** to the full report.
3. **Highlight** the top 3-5 remaining issues.
4. **Show** key screenshots if axe was run.
5. **Offer** to fix additional issues.

---

## Key Files for Reference

| File                                                             | Purpose                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/react/src/DocBlocksShell/index.ts`                     | Top-level shell — landmark structure starts here       |
| `packages/react/src/styles/docblocks.css`                        | Global styles + theme tokens (light/dark contrast)     |
| `packages/react/src/FileExplorer/FileExplorer.tsx`               | Tree control — should follow ARIA tree pattern         |
| `packages/react/src/FileExplorer/useFileTree.ts`                 | Tree state — keyboard handler hooks live here          |
| `packages/react/src/WorkspacePicker/WorkspaceSettingsDialog.tsx` | Reused modal pattern — focus-trap baseline             |
| `packages/react/src/Export/ExportDialog.tsx`                     | Form-heavy dialog — labels critical                    |
| `packages/react/src/AppMenu/AppMenu.tsx`                         | Menu surface — menubar / menu / menuitem ARIA          |
| `packages/desktop/renderer/UpdateStatusBanner.tsx`               | Live-region candidate                                  |
| `packages/vscode/webview/src/VscodeEditor.tsx`                   | VS Code webview — theme reactivity + focus boundary    |
| `packages/vscode/webview/src/vscodeApi.ts`                       | postMessage bridge — theme change events arrive here   |
| `packages/desktop/main/menu.ts`, `tray.ts`                       | Native Electron menu / tray — OS-rendered, defer to OS |

## Common Pitfalls

1. **Don't just report — fix.** Documenting an issue without fixing it is the #1 failure mode.
2. **Don't fight Squisq.** The editor itself lives in `..\qualla`. Editor-internal a11y is its responsibility; file issues upstream rather than monkey-patching from DocBlocks.
3. **Don't add ARIA where native HTML suffices.** A `<button>` doesn't need `role="button"`. A `<label>` is better than `aria-label` on a form control.
4. **Test after fixing.** Re-run the relevant e2e spec, Mocha tests, `npm run typecheck`, and `npm run lint`.
5. **Don't over-specify.** Only the minimum ARIA needed — extra ARIA confuses screen readers.
6. **Respect VS Code's chrome.** Don't override system colors or steal global shortcuts inside the webview.
7. **Theme parity matters.** Anything you fix must hold up in both light and dark theme, plus VS Code's High Contrast.

## Session Output Requirements

Every accessibility review MUST produce:

1. Either an automated axe scan or a documented manual sweep across every UI surface (site, desktop renderer, vscode webview, Setup pane)
2. Written report at `reports/a11y-review-YYYYMMDD-HHMM.md`
3. At least one issue fixed (or explicit statement that no fixable issues were found)
4. Surface-by-surface findings table
5. A "Gaps & Limitations" section noting what couldn't be assessed without a real screen reader / interactive testing / Squisq upstream changes
