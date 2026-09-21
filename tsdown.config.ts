import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: 'src/server.ts',
  format: 'esm',
  outDir: 'dist',
  outExtensions: () => ({ js: '.mjs' }),
  platform: 'node',
  target: 'node22',
  noExternal: [/.*/],
  clean: true,
});
