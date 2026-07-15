import { Command } from 'commander';
import { buildCommand } from './commands/build.js';
import { serveCommand } from './commands/serve.js';
import { convertCommand } from './commands/convert.js';
import { videoCommand } from './commands/video.js';
import { mcpCommand } from './commands/mcp.js';
import { themesCommand } from './commands/themes.js';
import { transformsCommand } from './commands/transforms.js';
import { parseCommand } from './commands/parse.js';
import { getPackageVersion } from './version.js';

const program = new Command();

program
  .name('docblocks')
  .description('Build, preview, convert, render, inspect, and automate documents')
  .version(getPackageVersion());

program.addCommand(buildCommand);
program.addCommand(serveCommand);
program.addCommand(convertCommand);
program.addCommand(videoCommand);
program.addCommand(mcpCommand);
program.addCommand(themesCommand);
program.addCommand(transformsCommand);
program.addCommand(parseCommand);

// Every action handler is async, and Commander does not await them from
// parse() — an action that rejects would surface as an unhandled rejection and
// a raw stack trace. parseAsync() plus this catch gives every command the same
// `Error: <message>` contract that build/parse already implement internally.
program.parseAsync().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
