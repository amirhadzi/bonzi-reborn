/** Pure helpers for scripts/build.mjs (kept separate so they can be unit tested). */

export interface BuildFlags {
  minify: boolean;
  sourcemap: boolean;
  watch: boolean;
}

/**
 * Parses build flags. Source maps default to on for development builds and off for minified
 * (distribution) builds; --sourcemap / --no-sourcemap override that.
 */
export function parseBuildArgs(argv: readonly string[]): BuildFlags {
  const known = new Set(['--minify', '--sourcemap', '--no-sourcemap', '--watch']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(' ')}`);
  const minify = argv.includes('--minify');
  let sourcemap = !minify;
  if (argv.includes('--sourcemap')) sourcemap = true;
  if (argv.includes('--no-sourcemap')) sourcemap = false;
  return { minify, sourcemap, watch: argv.includes('--watch') };
}

/**
 * Module specifiers passed to require() with a string literal, in order of appearance (deduplicated).
 * Dynamic requires (non-literal arguments) are reported as '<dynamic>'.
 */
export function findRequires(code: string): string[] {
  const found = new Set<string>();
  const re = /(?<![\w$.])require\s*\(\s*(?:"([^"\\]*)"|'([^'\\]*)'|`([^`\\$]*)`|([^)\s]))/g;
  for (const m of code.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3];
    found.add(spec ?? '<dynamic>');
  }
  return [...found];
}

/** Requires in a sandboxed preload bundle other than 'electron'. Empty means the bundle is safe to load. */
export function disallowedPreloadRequires(code: string): string[] {
  return findRequires(code).filter((spec) => spec !== 'electron');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
