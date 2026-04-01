import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { buildCommand } from './commands/build.js';
import { serveCommand } from './commands/serve.js';
import { convertCommand } from './commands/convert.js';
import { videoCommand } from './commands/video.js';
import { mcpCommand } from './commands/mcp.js';
import { themesCommand } from './commands/themes.js';
import { transformsCommand } from './commands/transforms.js';
import { parseCommand } from './commands/parse.js';

const program = new Command();

program
  .name('docblocks')
  .description('DocBlocks CLI — build, serve, and manage markdown document projects')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(buildCommand);
program.addCommand(serveCommand);
program.addCommand(convertCommand);
program.addCommand(videoCommand);
program.addCommand(mcpCommand);
program.addCommand(themesCommand);
program.addCommand(transformsCommand);
program.addCommand(parseCommand);

program.parse();
