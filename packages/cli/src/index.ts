/** Side-effect-free programmatic API for @bendyline/docblocks-cli. */

export { runBuild } from './commands/build.js';
export type { BuildOptions, BuildResult } from './commands/build.js';

export { applyTransformToMarkdown, runConvert } from './commands/convert.js';
export type { ConvertOptions, ConvertResult } from './commands/convert.js';

export { assertCliVideoRenderBudget, runVideo } from './commands/video.js';
export type { VideoOptions, VideoResult, VideoRunDependencies } from './commands/video.js';

export { runParse } from './commands/parse.js';
export type { ParseOptions } from './commands/parse.js';

export { getPackageVersion } from './version.js';
