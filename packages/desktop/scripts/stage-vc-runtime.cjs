/**
 * Stage the Microsoft Visual C++ runtime DLLs for a Windows package.
 *
 * Every bundled native engine (`gezel-*-server.exe`, their ggml DLLs) and
 * ONNX Runtime import MSVCP140 / VCRUNTIME140(_1). Those ship in the Visual
 * C++ 2015-2022 Redistributable, which is not a Windows component, so on a
 * clean machine the loader refuses the engine before `main()`.
 *
 * Gezel installs the redistributable centrally from its NSIS installer. That
 * needs elevation, and DocBlocks deliberately installs per user with
 * `allowElevation: false`, so DocBlocks deploys the DLLs app-local instead —
 * a deployment Microsoft documents and licenses. They are staged into their
 * own `resources/vc-runtime` folder rather than beside the engines, because
 * the Gezel payload is verified file by file; main prepends the folder to
 * PATH for child processes. The loader searches system directories before
 * PATH, so a serviced runtime already installed on the machine still wins.
 *
 * Source: the build host's Visual Studio redist folder, whose version matches
 * the toolset. Each DLL must carry a valid Microsoft Authenticode signature.
 *
 * Environment:
 *   DOCBLOCKS_VCRUNTIME_REQUIRED=1 — fail instead of warning (release CI).
 *   DOCBLOCKS_VCRUNTIME_DIR        — explicit Microsoft.VC14x.CRT folder.
 */
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { copyFile, mkdir, readdir, rm } = require('node:fs/promises');
const path = require('node:path');

/** The two the engines cannot load without; `_1` exists only for some arches. */
const REQUIRED_DLLS = ['msvcp140.dll', 'vcruntime140.dll'];
const OPTIONAL_DLLS = ['vcruntime140_1.dll'];

function vswhereInstallPaths(env = process.env) {
  const vswhere = path.join(
    env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  if (!existsSync(vswhere)) return [];
  try {
    return execFileSync(
      vswhere,
      ['-latest', '-products', '*', '-property', 'installationPath', '-nologo'],
      { encoding: 'utf8' },
    )
      .split(/\r?\n/u)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * `<vs>/VC/Redist/MSVC/<version>/<arch>/Microsoft.VC14x.CRT/`. The highest
 * toolset version wins; it matches the newest compiler present.
 */
async function findCrtFolder(vsRoots, arch) {
  for (const root of vsRoots) {
    const redistRoot = path.join(root, 'VC', 'Redist', 'MSVC');
    let versions;
    try {
      versions = await readdir(redistRoot);
    } catch {
      continue;
    }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const archDir = path.join(redistRoot, version, arch);
      let entries;
      try {
        entries = await readdir(archDir);
      } catch {
        continue;
      }
      const crt = entries
        .filter((entry) => /^Microsoft\.VC\d+\.CRT$/u.test(entry))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
      if (crt && REQUIRED_DLLS.every((dll) => existsSync(path.join(archDir, crt, dll)))) {
        return path.join(archDir, crt);
      }
    }
  }
  return null;
}

/** Only ship a DLL that Windows itself agrees Microsoft signed. */
function verifyMicrosoftSignature(file) {
  const script = `
    Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
    $sig = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/gu, "''")}'
    if ($sig.Status -ne 'Valid') { Write-Output "INVALID:$($sig.Status)"; exit 0 }
    Write-Output "OK:$($sig.SignerCertificate.Subject)"
  `;
  // pwsh 7's PSModulePath can stop Windows PowerShell 5.1 autoloading its own
  // security module (the same trap Gezel's stage-vc-redist documents).
  const { PSModulePath: _ignored, ...env } = process.env;
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env,
  }).trim();
  if (!out.startsWith('OK:') || !/O=Microsoft Corporation/iu.test(out)) {
    throw new Error(`Refusing an unverified Visual C++ runtime DLL ${file} (${out}).`);
  }
}

/**
 * Copy the runtime into `destination`. Returns the staged file names, or an
 * empty list when nothing was found and the build does not require it.
 */
async function stageVcRuntime({
  arch,
  destination,
  env = process.env,
  vsRoots,
  verify = verifyMicrosoftSignature,
  warn = (message) => process.stderr.write(`${message}\n`),
}) {
  const required = env.DOCBLOCKS_VCRUNTIME_REQUIRED === '1';
  const configured = env.DOCBLOCKS_VCRUNTIME_DIR?.trim();
  const source = configured || (await findCrtFolder(vsRoots ?? vswhereInstallPaths(env), arch));
  // Always leave the folder (possibly empty) so the extraResources entry that
  // copies it never names a missing path.
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  if (!source || !REQUIRED_DLLS.every((dll) => existsSync(path.join(source, dll)))) {
    const message = `Visual C++ runtime for win32/${arch} not found${configured ? ` in ${configured}` : ''}.`;
    if (required) throw new Error(message);
    warn(`${message} Native engines will need the redistributable installed on the machine.`);
    return [];
  }
  const files = [
    ...REQUIRED_DLLS,
    ...OPTIONAL_DLLS.filter((dll) => existsSync(path.join(source, dll))),
  ];
  for (const file of files) {
    verify(path.join(source, file));
    await copyFile(path.join(source, file), path.join(destination, file));
  }
  return files;
}

exports.stageVcRuntime = stageVcRuntime;
exports.findCrtFolder = findCrtFolder;
exports.REQUIRED_DLLS = REQUIRED_DLLS;
