import { fileURLToPath, URL } from 'node:url';
import { configureCapacitorProject } from '@bendyline/gezel-capacitor/packaging';
await configureCapacitorProject({
  projectRoot: fileURLToPath(new URL('../', import.meta.url)),
  platform: 'ios',
});
