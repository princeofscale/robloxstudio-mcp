import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  bundle: true,
  splitting: false,
  clean: true,
  noExternal: ['@princeofscale/robloxstudio-mcp-core'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
