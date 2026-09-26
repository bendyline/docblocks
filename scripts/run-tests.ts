import { createRequire } from 'node:module';

// React selects its development or production runtime when it is first
// imported. Keep ambient shell and npm configuration from disabling act().
process.env.NODE_ENV = 'test';

// The canonical suite owns the only coverage of a real rendered conversion
// (ffmpeg plus a Playwright browser). Those tests used to skip themselves
// whenever either dependency was absent, so a runner that lost them reported
// the same green as one that ran them. Require them here — both dependencies
// come from a normal install — and let a developer opt out deliberately with
// DOCBLOCKS_REQUIRE_RENDERED_MEDIA=0 rather than by accident.
process.env.DOCBLOCKS_REQUIRE_RENDERED_MEDIA ??= '1';

createRequire(import.meta.url)('mocha/bin/mocha.js');
