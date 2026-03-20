import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { buildCommand } from './commands/build.js';
import { serveCommand } from './commands/serve.js';

const program = new Command();

program
  .name('docblocks')
  .description('DocBlocks CLI — build, serve, and manage markdown document projects')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(buildCommand);
program.addCommand(serveCommand);

program.parse();
