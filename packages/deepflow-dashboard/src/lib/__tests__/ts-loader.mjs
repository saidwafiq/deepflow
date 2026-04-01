/**
 * Custom ESM loader: remaps `.js` specifiers to `.ts` when the `.js` file
 * doesn't exist but a `.ts` counterpart does. Enables running TypeScript source
 * files directly with `node --experimental-strip-types --loader` without a
 * build step.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function resolve(specifier, context, nextResolve) {
  // Only process relative imports with .js extension
  if (specifier.endsWith('.js') && context.parentURL) {
    const parentPath = fileURLToPath(context.parentURL);
    const parentDir = parentPath.substring(0, parentPath.lastIndexOf('/'));
    const jsPath = specifier.startsWith('/')
      ? specifier
      : parentDir + '/' + specifier;
    const tsPath = jsPath.replace(/\.js$/, '.ts');

    if (!existsSync(jsPath) && existsSync(tsPath)) {
      const tsSpecifier = specifier.replace(/\.js$/, '.ts');
      return nextResolve(tsSpecifier, context);
    }
  }
  return nextResolve(specifier, context);
}
