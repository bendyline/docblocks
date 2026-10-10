import { checkGezelLinks, linkGezel, unlinkGezel } from './gezel-links.js';

try {
  if (process.argv[2] === '--unlink') {
    unlinkGezel();
    process.stdout.write(
      'Removed local Gezel links, keeping installed packages or restoring saved copies.\n',
    );
  } else if (process.argv[2] === '--check') {
    checkGezelLinks();
  } else if (process.argv[2] === undefined) {
    linkGezel();
    process.stdout.write(
      'Linked desktop Gezel to ../gezel. Run npm run build:gezel-linked, then restart Electron.\n',
    );
  } else {
    throw new Error('Usage: link-gezel.ts [--check | --unlink]');
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
