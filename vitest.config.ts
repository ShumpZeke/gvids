import { defineConfig } from 'vitest/config';
import { isolateTemp } from './tests/helpers/temp-root.js';

isolateTemp();

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    environment: 'node',
    testTimeout: 20_000,
    restoreMocks: true,
  },
});
