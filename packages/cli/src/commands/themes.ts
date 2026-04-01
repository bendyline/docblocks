/**
 * themes command — list all available squisq themes.
 */

import { Command } from 'commander';

export const themesCommand = new Command('themes')
  .description('List all available visual themes')
  .action(async () => {
    const { getAvailableThemes } = await import('@bendyline/squisq/schemas');
    const themes = getAvailableThemes();
    console.error('Available themes:\n');
    for (const theme of themes) {
      process.stdout.write(`  ${theme}\n`);
    }
  });
