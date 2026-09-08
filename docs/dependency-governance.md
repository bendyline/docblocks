# Dependency governance

DocBlocks treats dependency installation as privileged code execution. The
repository uses npm's native release-age and install-script controls, and
`npm run all` begins by checking that those controls still agree with the
lockfile.

## Package version cooldown

Third-party package versions must have been published for at least seven full
days before they can be selected by `npm install`, `npm update`, or
`npm audit fix`. The project `.npmrc` sets `min-release-age=7`, so a newly
published `latest` version is not eligible until its cooldown has elapsed. Keep
dependencies exact-pinned; do not bypass the window by editing a manifest or
lockfile by hand.

The sole exception is the internally maintained Squisq package family,
`@bendyline/squisq*`. npm applies that exception only to the matching Squisq
package itself; Squisq's third-party dependencies still observe the cooldown.
Do not add another exclusion to `.npmrc`.

The exclusion feature requires npm 11.17 or newer. The repository pins npm
11.19.1 for contributor and CI commands. That release contains patched
versions of npm's bundled `tar`, `ip-address`, `brace-expansion`, and `undici`
dependencies; npm 12.0.2 did not, and no patched npm 12 release was available
when this pin was reviewed on September 7, 2026. npm 11.19.1 was published on
August 26, so it also satisfies the seven-day cooldown. CI installs that exact
npm version before installing project dependencies. The `packageManager` field
is the exact toolchain pin, and the root development dependency ensures nested
`npm run` commands resolve that same CLI instead of a transitive npm
executable. `engines.npm` communicates the minimum to npm clients.

If `npm audit fix` reports that a patched version is too new, leave the current
pin in place until the seven-day window expires. Do not use
`npm audit fix --force` as a cooldown bypass; `--force` can also introduce
breaking dependency changes.

## Complete vulnerability review

`npm run check:dependency-audit` runs `npm audit --json` against the exact
lockfile. It retains npm's unmodified response plus normalized JSON and
Markdown evidence under `reports/dependency-audit/`. The canonical `npm run
all` gate runs it immediately after dependency-governance validation, and the
desktop release workflow retains those private reports as a workflow artifact
for 90 days. The public release job downloads only `*-artifacts`, so the
dependency inventory is not attached to the GitHub Release.

Every advisory object in the current npm report must have exactly one entry in
`security/dependency-audit-dispositions.json`. The gate fails when a finding is
missing a disposition, a disposition is stale or expired, the declared
severity changes, or the review is more than 30 days old. Dispositions may not
extend more than 30 days. Critical findings always block, and high or critical
findings that affect shipped code cannot be accepted by policy. A package-floor
check remains useful for vulnerabilities that npm does not model, but it is not
a substitute for this finding-level review.

The current exception is deliberately narrow: `@tiptap/core` is a moderate
shipped-code finding whose fixed major line requires a coordinated
Squisq/Tiptap migration. The advisory notes that standard fixed ProseMirror
schemas discard unknown attributes; DocBlocks does not accept runtime plugins
or arbitrary schemas, and renderer CSP further limits active content while the
migration is completed.

The root exact overrides select `esbuild@0.28.1` only for `tsup` and `tsx`, and
`serialize-javascript@7.0.5` only for Mocha. They intentionally cross those
parents' declared ranges to select patched versions already exercised by the
parallel Squisq checkout. Vite keeps its separate `esbuild@0.25` line, which is
outside the affected range and is required for Vite 6's legacy-browser
transforms. DocBlocks' full build and test gates cover all of these consumers.
Keep the overrides until every parent raises its own dependency range; removing
one must make the complete audit gate prove that the vulnerable line did not
return.

Renewing an exception requires re-reading the advisory, confirming the exact
dependency path and shipped scope, updating the reason and remediation, and
setting a new date no more than 30 days out. Remove the disposition as soon as
the lockfile no longer reports it; stale entries fail the gate.

## Install-script policy

`package.json#allowScripts` is the root workspace's explicit permission list.
Approvals are exact-version pins; a package name, wildcard, dist-tag, caret, or
tilde range is not acceptable. `.npmrc` sets `strict-allow-scripts=true`, so an
install fails when the lockfile introduces an unreviewed lifecycle script.

The initial approvals were reviewed against the scripts installed from the
lockfile and admitted only after their npm publication timestamps were more
than seven days old:

| Package version(s)                    | Install-time behavior                                                                                                | Published (UTC)        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `@playwright/browser-chromium@1.58.2` | Downloads the Chromium, headless-shell, and FFmpeg runtime used by VS Code Web tests.                                | 2026-02-06             |
| `@vscode/vsce-sign@2.0.9`             | Selects the platform signing binary; its fallback can fetch the matching npm binary package.                         | 2025-11-13             |
| `electron-winstaller@5.4.0`           | Copies the checked-in host-architecture 7-Zip executable used for Windows packaging.                                 | 2024-07-23             |
| `esbuild@0.25.12`, `esbuild@0.28.1`   | Selects and validates esbuild's platform binary.                                                                     | 2025-11-01; 2026-06-12 |
| `ffmpeg-static@5.2.0`                 | Downloads the platform FFmpeg binary used by CLI video rendering.                                                    | 2023-07-07             |
| `fsevents@2.3.2`, `fsevents@2.3.3`    | Builds the optional macOS filesystem-events native module through npm's implicit `node-gyp rebuild`.                 | 2021-02-05; 2023-08-21 |
| `keytar@7.9.0`                        | Installs a prebuilt native credential-store module or falls back to `node-gyp`; it is optional tooling beneath VSCE. | 2022-02-17             |

To review a future change:

1. Inspect every `preinstall`, `install`, `postinstall`, implicit `node-gyp`, and
   non-registry `prepare` script, including network downloads and native binary
   selection.
2. Check the exact version's timestamp with `npm view <package> time --json` and
   wait until seven full days have elapsed. Squisq is the only release-age
   exception, not an automatic install-script approval.
3. Add only the exact lockfile version to `package.json#allowScripts`. Exact
   versions of the same package may be joined with `||`.
4. Run `npm run check:dependency-governance` and then `npm run all`.

The governance check reads `package-lock.json` rather than the current
platform's `node_modules`, so optional scripts needed only on macOS, Windows,
or Linux cannot disappear from review on another host. It also rejects stale
approvals after a dependency version leaves the lockfile.
