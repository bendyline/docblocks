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

Our own packages are exempt: everything under the `@bendyline` scope
(`@bendyline/*`). That covers Squisq, the editor every surface embeds; Gezel,
the local AI runtime behind DocBlocks' AI features, which DocBlocks is also used
to prove out; and the first-party packages those two publish alongside
themselves, such as `@bendyline/gezk` and `@bendyline/gilde`. Naming families
one at a time kept blocking same-day releases on a sibling package the patterns
missed, so the scope is exempt as a whole.

All of them are internally maintained and developed alongside DocBlocks, so
waiting a week for our own release would only delay a fix we wrote. npm applies
an exclusion only to the matching package itself: every third-party dependency
of a `@bendyline` package still observes the cooldown.

`scripts/check-dependency-governance.ts` requires exactly this exemption.
Changing it is a policy decision, not a configuration edit: change the checker,
this document, and AGENTS.md in the same commit. Never exempt a third-party
package.

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

The canonical gate starts that pinned CLI through
`scripts/run-canonical-gate.ts`. Newer npm releases may export configuration
defaults that npm 11 does not recognize; the runner removes only the obsolete
`npm_config_global_ignore_file` lifecycle variable before starting the pinned
CLI. This prevents a warning on every nested command without changing npm 11's
configuration or dependency-policy behavior.

If `npm audit fix` reports that a patched version is too new, leave the current
pin in place until the seven-day window expires. Do not use
`npm audit fix --force` as a cooldown bypass; `--force` can also introduce
breaking dependency changes.

## Vulnerability audit

`npm run check:dependency-audit` runs `npm audit --omit=dev --json`, so it
covers only what ships: the production dependencies of every workspace. Build
tools, test runners, release tooling and the pinned npm's own bundled packages
never reach a user, so they do not take part. Run a plain `npm audit` to see
those.

Only **critical** advisories fail the gate. Everything else is listed in the
evidence report and in the gate's one-line summary, and is fixed in the normal
course of dependency updates. A new moderate or high advisory published
somewhere in the tree therefore never breaks `npm run all` on the day the
advisory database changes.

When a critical advisory appears, update the dependency. If the fix cannot be
installed yet, usually because it is still inside the seven-day cooldown, add
the advisory to `security/audit-exceptions.json` with a one-line reason:

```json
{
  "GHSA-xxxx-xxxx-xxxx": "example-pkg 1.2.4 fixes it; installable once its cooldown ends on 2026-10-12"
}
```

Exceptions have no expiry. Once npm stops reporting an excepted advisory, the
gate prints a notice that the entry can be deleted; it never fails because of
one.

The gate writes npm's raw response and a Markdown summary to
`reports/dependency-audit/`. The desktop release workflow retains that
directory as a private workflow artifact for 90 days. The public release job
downloads only `*-artifacts`, so the dependency inventory is not attached to
the GitHub Release.

Some findings are fixed but still reported. `@tiptap/core` GHSA-CP6Q-959Q-F8RH
is one: Squisq ships Tiptap 2.27.3, which backports the upstream fix, but the
advisory lists every 2.x release as affected.
`packages/react/test/tiptap-prototype-safety.test.ts` proves the fix against
the Tiptap DocBlocks actually installs.

The root exact overrides select `esbuild@0.28.1` only for `tsup` and `tsx`, and
`serialize-javascript@7.0.5` only for Mocha. They intentionally cross those
parents' declared ranges to select patched versions already exercised by the
parallel Squisq checkout. Two more stay inside their parents' ranges and exist
only because `npm update` would not re-resolve those nodes: `brace-expansion@1.1.21`
for `minimatch@3.1.5`, and `serialize-javascript@7.1.2` for
`@rollup/plugin-terser`. Vite keeps its separate `esbuild@0.25` line, which is
outside the affected range and is required for Vite 6's legacy-browser
transforms. DocBlocks' full build and test gates cover all of these consumers.
Keep the overrides until every parent raises its own dependency range; these
are development tools, so check with a plain `npm audit` that the vulnerable
line did not return when removing one.

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
   wait until seven full days have elapsed. The Squisq and Gezel release-age
   exceptions are not install-script approvals: a script in either family is
   reviewed and pinned like any other.
3. Add only the exact lockfile version to `package.json#allowScripts`. Exact
   versions of the same package may be joined with `||`.
4. Run `npm run check:dependency-governance` and then `npm run all`.

The governance check reads `package-lock.json` rather than the current
platform's `node_modules`, so optional scripts needed only on macOS, Windows,
or Linux cannot disappear from review on another host. It also rejects stale
approvals after a dependency version leaves the lockfile.
