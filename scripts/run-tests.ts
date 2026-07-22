import { createRequire } from 'node:module';

// React selects its development or production runtime when it is first
// imported. Keep ambient shell and npm configuration from disabling act().
process.env.NODE_ENV = 'test';

createRequire(import.meta.url)('mocha/bin/mocha.js');
