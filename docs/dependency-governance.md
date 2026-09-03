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

The exclusion feature requires npm 11.17 or newer. The repository pins the
newer npm 12.0.2 for contributor and CI commands; it was the latest stable npm
release when reviewed and had been published since July 29, 2026, well beyond
the seven-day window. CI installs that exact npm version before installing
project dependencies. The `packageManager` field is the exact toolchain pin;
`engines.npm` communicates the minimum to npm clients.

If `npm audit fix` reports that a patched version is too new, leave the current
pin in place until the seven-day window expires. Do not use
`npm audit fix --force` as a cooldown bypass; `--force` can also introduce
breaking dependency changes.

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
| `esbuild@0.25.12`, `esbuild@0.27.7`   | Selects and validates esbuild's platform binary.                                                                     | 2025-11-01; 2026-04-02 |
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
