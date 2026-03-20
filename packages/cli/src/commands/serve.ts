import { Command } from 'commander';

export const serveCommand = new Command('serve')
  .description('Start a local dev server for previewing markdown files')
  .option('-p, --port <port>', 'port to listen on', '3000')
  .option('-d, --dir <dir>', 'directory to serve', '.')
  .action((opts: { port: string; dir: string }) => {
    console.error(
      `serve command is not yet implemented. Would serve ${opts.dir} on port ${opts.port}.`,
    );
    console.error('This will be implemented in a future release.');
  });
