import { defineConfig } from 'vitest/config';
import { isolateTemp } from './tests/helpers/temp-root.js';

isolateTemp();

// Live tests talk to real Google services. They need `gvids auth login` and/or
// `gvids browser login` to have been run first, plus GVIDS_LIVE=1.
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.test.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    environment: 'node',
    testTimeout: 15 * 60_000,
    hookTimeout: 5 * 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
