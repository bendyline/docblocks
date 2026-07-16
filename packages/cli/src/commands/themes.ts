/**
 * themes command — list all available squisq themes.
 */

import { Command } from 'commander';
import { getAvailableThemeIds } from '../internal/theme.js';

export const themesCommand = new Command('themes')
  .description('List all available visual themes')
  .action(async () => {
    const themes = await getAvailableThemeIds();
    console.error('Available themes:\n');
    for (const theme of themes) {
      process.stdout.write(`${theme}\n`);
    }
  });
