import { defineConfig } from 'vitest/config';

// The sources use NodeNext-style imports that point at a sibling `./x.js` even
// though the file on disk is `x.ts` (this is how `tsx` runs them). Vite/Vitest
// will not map `.js` -> `.ts` on its own, so do it in a pre-resolver that runs
// before Vite's default resolution.
const tsJsExtensionResolver = {
  name: 'ts-js-ext',
  enforce: 'pre' as const,
  async resolveId(source: string, importer: string | undefined) {
    if (importer && source.startsWith('.') && source.endsWith('.js')) {
      const resolved = await this.resolve(
        `${source.slice(0, -3)}.ts`,
        importer,
        { skipSelf: true },
      );
      if (resolved) {
        return resolved;
      }
    }
    return null;
  },
};

export default defineConfig({
  plugins: [tsJsExtensionResolver],
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/testing/**', 'src/generated/**'],
    },
  },
});
