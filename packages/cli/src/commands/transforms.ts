/**
 * transforms command — list all available transform styles.
 */

import { Command } from 'commander';

export const transformsCommand = new Command('transforms')
  .description('List all available transform styles')
  .action(async () => {
    const { getTransformStyleIds } = await import('@bendyline/squisq/transform');
    const styles = getTransformStyleIds();
    console.error('Available transform styles:\n');
    for (const style of styles) {
      process.stdout.write(`  ${style}\n`);
    }
  });
