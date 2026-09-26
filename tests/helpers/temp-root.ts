import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEMP_PREFIX = 'gvids-tests-';

/**
 * Point TEMP/TMP/TMPDIR at one fresh folder for the whole test run, so every temp
 * file (the tests' GVIDS_HOME folders, vitest's own module copies, files written by
 * the code under test) lands there; global-setup.ts removes it when the run ends.
 * Called from the vitest config files, before vitest picks its own temp folder.
 */
export function isolateTemp(): void {
  if (path.basename(os.tmpdir()).startsWith(TEMP_PREFIX)) return;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = temp;
}
