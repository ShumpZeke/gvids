import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEMP_PREFIX } from './temp-root.js';

// Removes the run's temp folder (see temp-root.ts) when the run ends.
export default function setup(): () => void {
  const temp = os.tmpdir();
  return () => {
    if (!path.basename(temp).startsWith(TEMP_PREFIX)) return;
    try {
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.warn(`Could not remove the test temp folder ${temp}: ${String(error)}`);
    }
  };
}
