---
name: uxreview
description: Evaluate the DocBlocks UI's user experience — visual design, information architecture, interaction patterns across the site shell, Electron desktop renderer, and VS Code custom editor webview. Captures screenshots from existing Playwright runs (root e2e, desktop e2e, vscode e2e), reviews them, and produces an opinionated report with prioritized findings.
---

# UX Review Skill

You are a world-class UX reviewer obsessed with making DocBlocks the most usable, delightful, and trustworthy markdown document editor for writers, technical communicators, and developers. You evaluate the live application by capturing screenshots, examining them visually, and producing an actionable report with prioritized findings.

**Your north star:** Would a discerning user — someone who's used Notion, Obsidian, iA Writer, Bear, Typora, and the modern crop of polished markdown editors — open DocBlocks (in any of its three surfaces: web, desktop app, or as their VS Code markdown editor) and feel like _this_ is the calm, well-organized, file-on-disk-friendly home for their writing? Would they recommend it to a colleague?

## When This Skill Runs

This is NOT a content / pipeline / editor-behavior skill. It evaluates the **shell and chrome around the editor** — the layout, the visual design, the feel of DocBlocks's UI. Squisq is the actual document editor (sister project in `..\qualla`); UX critique of the editing surface itself belongs there. Run this skill:

- After shipping a new view, modal, or component in `packages/react/src/`
- After meaningful changes to the Electron renderer (`packages/desktop/renderer/`) or VS Code webview (`packages/vscode/webview/`)
- Before a release to catch regressions
- When the user asks for a UX audit or quality check
- Periodically to maintain a high bar

## Prerequisites

- Builds are current (`npm run build`) so the e2e suites can launch their surfaces
- Playwright is installed (root devDep)
- For site e2e: the site dev server can be started by the root `playwright.config.ts` (`webServer: npm run dev -w docblocks-site`)
- For desktop e2e: `npm run build:desktop` first

```bash
# Verify builds
ls packages/react/dist 2>/dev/null && echo "react built" || echo "needs npm run build:react"
ls packages/desktop/dist 2>/dev/null && echo "desktop built" || echo "needs npm run build:desktop"
ls packages/vscode/dist 2>/dev/null && echo "vscode built" || echo "needs npm run build:vscode"
```

If builds are stale, run `npm run build` first.

---

## Step 1: Capture Screenshots from Existing E2E Specs

DocBlocks has three Playwright configurations driving three different surfaces. **Do NOT write new specs unless absolutely necessary.** Run the existing ones — they exercise the major surfaces and produce screenshots / traces under each config's `test-results/` and `playwright-report/`.

### Specs and what they cover

| Spec                                                | Surface           | What it Covers                                                    |
| --------------------------------------------------- | ----------------- | ----------------------------------------------------------------- |
| `e2e/app.spec.ts` (root)                            | Site (web)        | Shell renders, sidebar, workspace picker, app menu, file explorer |
| `packages/desktop/e2e/app-lifecycle.spec.ts`        | Electron desktop  | App boot, window lifecycle                                        |
| `packages/desktop/e2e/fixtures.ts`                  | Electron desktop  | Test helpers (Electron launcher)                                  |
| `packages/vscode/e2e/extension.spec.ts`             | VS Code extension | Activation, Setup pane environment checks                         |
| `packages/vscode/e2e/markdown-editor-smoke.spec.ts` | VS Code webview   | Custom editor renders for \*.md, basic UI                         |

### Run commands

```bash
# Root — drives the site dev server (port 5220)
npm run test:e2e

# Single spec without rebuilding
npx playwright test e2e/app.spec.ts --reporter=list

# Electron — requires a current desktop build
npm run build:desktop && npm run test:e2e:desktop

# VS Code — uses VS Code for Web on port 3100
npm run test:e2e:vscode
```

### What Playwright produces

- `test-results/` (and per-package equivalents) — failure artifacts (screenshots, videos, traces) for any test that failed or has `trace: 'on-first-retry'` in config
- `playwright-report/` — HTML report with embedded screenshots
- Test-spec-saved screenshots — wherever specs / fixtures explicitly call `page.screenshot({ path: ... })`. Read the specs and fixtures to find these.

### After tests complete

1. **Don't get stuck on test failures.** Some may fail — record those in the report. Use whatever screenshots / traces were produced.
2. **List artifacts.** Use Glob to find:
   - `test-results/**/*.png`
   - `playwright-report/**/*.png`
   - `packages/desktop/test-results/**/*.png`
   - `packages/vscode/test-results/**/*.png`
3. **Prioritize strategically.** You don't need to examine every screenshot. Aim for 12-18 covering:
   - **Site**: shell loaded, file explorer with content, workspace picker open, export dialog, workspace settings dialog
   - **Desktop**: same as site, plus the UpdateStatusBanner if it appears, the native menu (where visible in the screenshot)
   - **VS Code**: the custom editor open with a markdown file, the Setup pane, theme variations (light + dark if specs cover them)

## Step 2: Visual Inspection

**Read each selected screenshot using the Read tool.** Look at each carefully before forming opinions. Use whichever lenses fit each screenshot.

### What you CAN assess from screenshots

#### Visual Hierarchy & Layout

- Is the most important content (the document itself) the most prominent?
- Clear hierarchy — file tree < toolbar < document?
- Whitespace intentional — neither cramped nor sparse?
- Elements aligned to a grid? Icons consistently sized?

#### Typography & Readability

- Body text in the editor comfortable to read (size, line-height, measure)?
- Code / monospace blocks distinguishable from prose?
- The 17 embedded fonts (in `packages/react/src/fonts/`) — are they being used purposefully, or hand-wavingly?
- Truncation handled gracefully in long filenames, long workspace names?

#### Color & Visual Identity

- Palette cohesive across light and dark themes? (DocBlocksShell's `theme` prop supports `light` / `dark` / `auto`)
- Accent colors guiding attention without overwhelming?
- Sufficient contrast (WCAG AA — also covered by `a11yreview`)?
- Status indicators (autosave success, update available, workspace switched) distinguishable _not by color alone_?
- VS Code custom editor: theme parity with VS Code's own theme (Light+ / Dark+ / HC)?

#### Information Density

- File explorer: scannable tree or wall of folders?
- Workspace picker: room for many workspaces or designed for 1-3?
- Settings dialogs: progressive disclosure or "show every checkbox"?
- Export dialog: feels like a focused flow or a kitchen sink?

#### Navigation & Wayfinding

- Can a new user figure out where they are?
- Active workspace clearly indicated?
- Breadcrumbs / file path visible when deep in a tree?
- Clickable elements obviously clickable (affordance)?

#### Empty States

- "No workspace yet" / "No files yet" — friendly + actionable?
- First-run experience on each surface: greeting? Clear next step?
- Site empty state: does it explain that DocBlocks works without an account?

#### Document Editing Surface (chrome only)

- Toolbar density — overwhelming or right-sized?
- Tool-call cards / inline UI from squisq — do they read as part of the document or as an intrusion?
- Long documents: scroll position, sticky elements
- _Note: actual editor a11y / quality is squisq's responsibility — focus on the DocBlocks chrome around it_

#### Forms & Dialogs

- Labels above inputs vs placeholder-only?
- Required vs optional clearly marked?
- Help text where ambiguous?
- Primary vs secondary button hierarchy unambiguous?

#### Modals & Dialogs (WorkspaceSettings, Export, About)

- Backdrop dimming present? Modal sized for content, not min-or-max-extreme?
- Confirm / cancel button hierarchy clear (primary action visually dominant)?
- Modal closes cleanly, returns user to a sensible place?

#### Update / Status Surfaces (Electron only)

- UpdateStatusBanner unobtrusive when idle, clear when action needed?
- Doesn't dominate the screen during downloads?
- Restart prompt obvious but not aggressive?

#### Multi-Surface Parity

- Does the site shell feel like the desktop shell feels like the VS Code editor?
- Or do they feel like three different products that happen to share fonts?
- Where intentional divergence exists (desktop has UpdateStatusBanner; VS Code has Setup pane), does it feel native rather than bolted on?

#### Trust & Polish

- Does the experience feel _cared for_ vs. thrown together?
- Misalignments, mismatched padding, broken icons?
- "I would happily ship this to a friend" or "I'd apologize first"?
- File-on-disk feel: does the UI reassure that "my markdown is just markdown, on disk, that I own"?

### What you CANNOT fully assess from screenshots

Note these as "unable to evaluate from static images" rather than guessing:

- **Interaction quality** — hover/focus states, scroll inertia, transition smoothness
- **Editor responsiveness** — typing latency, scroll-while-editing, undo/redo feel (and this is squisq's domain anyway)
- **Performance** — load times, layout shift, perceived responsiveness
- **Auto-save behavior** — does the autosave feel reassuring? Is the indicator timely?
- **Theme switching** — does it feel instant or laggy?
- **Keyboard navigation order** — covered by `a11yreview` skill, not here
- **Cross-platform parity** — Windows vs macOS chrome differences
- **VS Code integration** — how the webview feels inside actual VS Code (file save, dirty indicator, etc.) only fully assessable in a live VS Code session

---

## Step 3: Document Findings

### High-level picture

Your opinionated take is the most important outcome. Write 3-5 paragraphs honestly:

- What's the gestalt of the UX across all three surfaces?
- What did you find delightful?
- What annoyed you most?
- What surprised you?
- If you were showing this to a friend who builds writing tools for a living, what would you apologize for? What would you be proud of?
- Does the three-surface story hang together, or feel like three apps?
- The single most impactful thing to fix?

### Tier 1: Showstoppers (Must Fix)

Issues that actively harm the experience or would cause users to bounce:

- Broken layouts, overlapping elements, unreadable text
- Non-functional interactions (dead clicks, broken navigation)
- Jarring visual bugs (FOUC, layout shift on hover)
- Empty states that look like errors
- The UpdateStatusBanner blocking content
- VS Code custom editor failing to register / open \*.md files
- Site that doesn't communicate what DocBlocks does

### Tier 2: Polish Issues (Should Fix)

Issues a discerning user notices:

- Inconsistent spacing or alignment
- Missing hover/focus states
- Awkward text truncation in file/workspace names
- Suboptimal icon weight or sizing
- Surfaces that feel like three different products
- Modal hierarchy ambiguous (which button is primary?)
- Theme parity issues (something looks good in light, bad in dark)

### Tier 3: Delight Opportunities (Could Enhance)

Ideas to elevate good → great:

- Micro-interactions on file create / rename / delete
- Better loading states for export
- Empty-state illustrations or copy with personality
- Onboarding moments (first document created, first export completed)
- Subtle animation on workspace switch

---

## Step 4: Produce the UX Review Report

Write to `reports/ux-review-report-YYYYMMDD-HHMM.md` (create `reports/` if missing).

The report should feel like a thoughtful design critique, not a checklist. Lead with your honest impression, then support with specific findings.

```markdown
# DocBlocks UX Review Report

**Date:** YYYY-MM-DD
**Reviewer:** Codex (AI UX Review)
**Build/Commit:** [git short hash]
**Surfaces reviewed:** Site / Desktop / VS Code
**Screenshots reviewed:** [count] from test-results/ and playwright-report/ across the three configs

## The Big Picture

[3-5 paragraphs of honest, opinionated assessment. How did this experience make you
feel? What delighted you? What frustrated you? What felt unfinished? If you were
showing this to a friend, what would you apologize for? What would you be proud of?
Does the three-surface story hang together? What's the single most impactful thing to fix?]

## What's Working Well

[3-5 specific things to protect and build on. Reference screenshots.]

## Showstoppers (Tier 1 — Must Fix)

### [Issue title]

- **Surface:** Site / Desktop / VS Code
- **Where:** [component]
- **Screenshot:** [filename]
- **What's wrong:** [description]
- **Why it matters:** [user impact]
- **Suggested fix:** [concrete recommendation]

## Polish Issues (Tier 2 — Should Fix)

### [Issue title]

- **Surface:** Site / Desktop / VS Code
- **Where:** [component]
- **Screenshot:** [filename]
- **What's wrong:** [description]
- **Suggested fix:** [concrete recommendation]

## Delight Opportunities (Tier 3 — Could Enhance)

### [Opportunity title]

- **Surface:** Site / Desktop / VS Code
- **Where:** [component]
- **Idea:** [description]
- **Why it would help:** [expected impact]

## Surface-by-Surface Notes

| Surface / Component               | Impression | Key Issues |
| --------------------------------- | ---------- | ---------- |
| Site shell (web)                  | ...        | ...        |
| Desktop shell (Electron renderer) | ...        | ...        |
| Desktop UpdateStatusBanner        | ...        | ...        |
| Desktop native menu / tray        | ...        | ...        |
| VS Code custom editor (markdown)  | ...        | ...        |
| VS Code Setup pane                | ...        | ...        |
| DocBlocksShell (cross-surface)    | ...        | ...        |
| FileExplorer                      | ...        | ...        |
| WorkspacePicker / Settings dialog | ...        | ...        |
| AppMenu / About dialog            | ...        | ...        |
| Export dialog & toolbar           | ...        | ...        |

## Multi-Surface Parity

[2-3 paragraphs. Where does the three-surface story shine? Where does it feel
inconsistent? Are there surfaces where DocBlocks's identity gets lost in the
host chrome (especially VS Code)?]

## Notable Screenshots

[Link to 5-10 key screenshots illustrating the most important findings — both positive
and negative. Include a one-line caption explaining what each shows.]

## Gaps & Limitations

[What couldn't you assess from screenshots? Which views were missing? What would you
want to test interactively? Note that editor-internal UX is squisq's domain.]
```

---

## Step 5: Present Results

1. **Lead with your honest take** — 2-3 sentences on the overall state across all three surfaces.
2. **Link** to the full report.
3. **Highlight** the top 3-5 findings (with screenshot references).
4. **Recommend** which Tier 1 issues to fix first.
5. **Offer** to help fix specific issues.

---

## Review Principles

### What great looks like

Benchmarks for what DocBlocks's UX should aspire to:

- **iA Writer / Bear** — calm, opinionated writing surface; the document is the hero
- **Obsidian** — file-tree + editor cohabit gracefully; many workspaces feel manageable
- **Notion / Typora** — modal-less editing, formatting feels native rather than menu-driven
- **Linear** — calm density, opinionated information architecture across multiple panels
- **VS Code's own markdown preview** — the bar for VS Code-integrated editors

### Common anti-patterns

| Anti-pattern                | What it Looks Like                                                    | Why It's Bad                                            |
| --------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------- |
| **Three-products feeling**  | Site, desktop, and VS Code feel like different apps                   | Erodes brand identity, doubles user learning            |
| **Information overload**    | Every status pill, badge, and counter shown on every row              | Overwhelms; nothing stands out                          |
| **Ghost town**              | Empty site landing, sparse file explorer, no featured state           | Feels unfinished — and the README is currently one line |
| **Settings sprawl**         | Workspace settings and export options each follow a different pattern | Feels amateur                                           |
| **Inconsistent density**    | Cramped here, vast whitespace there                                   | Unpolished                                              |
| **Mystery icons**           | Icon-only buttons in primary chrome with no label                     | Users don't know what's clickable                       |
| **Modal-as-everything**     | A modal for every action, including ones that should be inline        | Aggressive, breaks flow                                 |
| **VS Code chrome battle**   | DocBlocks's editor styling clashes with VS Code's theme               | Feels foreign inside VS Code                            |
| **Update banner squatting** | UpdateStatusBanner taking permanent header real estate                | Distracting; users learn to ignore                      |
| **Auto-save anxiety**       | No autosave indicator, or one that flickers / lies                    | Erodes trust in a write-heavy tool                      |
| **Theme-switch jank**       | Light/dark switch causes layout shift or FOUC                         | Reads as buggy                                          |

### The "First 5 Seconds" test

For each entry surface (site landing, desktop app launch, VS Code custom editor opening a .md file):

1. What does the user see first? Compelling or confusing?
2. What should they do next? Is the call to action obvious?
3. What's the emotional tone? Inviting? Overwhelming? Empty?
4. Would they stay or bounce?

### The "Show a Friend" test

Imagine showing DocBlocks to a friend who builds writing or developer tools:

1. Would you feel **proud** or **apologetic**?
2. What would you **preemptively explain** because the UI doesn't?
3. What would they **try to do** that wouldn't work as expected?
4. Where would they ask "wait, why is _this_ surface different from _that_ one?"

### The "File-on-Disk Trust" test

DocBlocks's pitch is editing markdown that lives in workspaces (folders) you control. Does the UI reinforce that trust?

1. Are file paths shown when relevant?
2. Is it obvious where files go when created?
3. Does the workspace picker make the user feel in control of their files?
4. Does the export dialog make it clear where the export lands?

### The "Multi-Surface" test

DocBlocks is unusual in shipping three surfaces. The UX review must explicitly evaluate parity:

1. Do users get the same mental model on all three?
2. Where surfaces differ (UpdateStatusBanner on desktop; Setup pane in VS Code), is the difference _intentional and helpful_, or _accidental_?
3. Is there shared visual language (fonts, color tokens, iconography)?

---

## Focused Reviews

If the user asks for a focused review, scope screenshots and evaluation to that area:

| Focus area                     | Specs to run                                                    | What to evaluate                                                     |
| ------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| "Review the site"              | root `e2e/app.spec.ts`                                          | Marketing/demo positioning; empty state; shell affordances           |
| "Review the desktop app"       | `desktop/e2e/app-lifecycle.spec.ts`                             | Window chrome; menu; UpdateStatusBanner; file-on-disk trust          |
| "Review the VS Code extension" | `vscode/e2e/extension.spec.ts`, `markdown-editor-smoke.spec.ts` | Custom editor + Setup pane; theme parity; VS Code chrome integration |
| "Review the file explorer"     | All three (it's in every shell)                                 | Tree density; create/rename/delete affordances; drag-drop cues       |
| "Review export"                | (No spec covers it yet — note this)                             | Dialog quality; format clarity; destination obvious                  |
| "Review workspaces"            | All three                                                       | Picker design; settings dialog quality; folder picker (desktop)      |
| "Review theming"               | All three, both light + dark                                    | Parity; contrast; brand cohesion; VS Code HC theme                   |
| "Review modals"                | All three                                                       | Backdrop; sizing; primary-action hierarchy; close behavior           |

---

## Session Output Requirements

Every UX review MUST produce:

1. Screenshots collected from existing Playwright runs across the three configs (root, desktop, vscode) and any `test-results/` paths
2. Written report at `reports/ux-review-report-YYYYMMDD-HHMM.md`
3. An honest "Big Picture" narrative assessment
4. An explicit "Multi-Surface Parity" assessment
5. At least one Tier 1 finding (or explicit statement that none exist)
6. At least three specific, actionable recommendations with screenshot references
7. A "Gaps & Limitations" section noting what couldn't be assessed from static images (and what belongs in squisq, not DocBlocks)
