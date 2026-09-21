// The single source of truth for the version is package.json. The manifest serves VERSION,
// which is how a deploy confirms that the process now answering is the build just installed:
// a supervisor that failed to restart keeps answering happily otherwise. tsdown inlines this
// import at build time, so dist/server.mjs carries the literal rather than reading a file.
import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
