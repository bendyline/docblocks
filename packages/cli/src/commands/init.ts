import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

export const initCommand = new Command('init')
  .description('Initialize a DocBlocks workspace in the current directory')
  .argument('[dir]', 'directory to initialize', '.')
  .action((dir: string) => {
    const targetDir = path.resolve(dir);
    const configDir = path.join(targetDir, '.docblocks');

    if (fs.existsSync(configDir)) {
      console.error('DocBlocks workspace already initialized in this directory.');
      process.exitCode = 1;
      return;
    }

    fs.mkdirSync(configDir, { recursive: true });

    const config = {
      name: path.basename(targetDir),
      version: '0.1.0',
    };

    fs.writeFileSync(
      path.join(configDir, 'config.json'),
      JSON.stringify(config, null, 2) + '\n',
    );

    console.error(`Initialized DocBlocks workspace in ${targetDir}`);
  });
