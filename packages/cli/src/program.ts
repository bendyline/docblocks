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

export const program = new Command()
  .name('docblocks')
  .description('Build, preview, convert, render, inspect, and automate documents')
  .version(getPackageVersion())
  .addCommand(buildCommand)
  .addCommand(serveCommand)
  .addCommand(convertCommand)
  .addCommand(videoCommand)
  .addCommand(mcpCommand)
  .addCommand(themesCommand)
  .addCommand(transformsCommand)
  .addCommand(parseCommand);
