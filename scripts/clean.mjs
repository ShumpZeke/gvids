// Removes build output so a build never ships files whose sources were deleted.
import fs from 'node:fs';

for (const dir of ['dist', 'dist-check']) fs.rmSync(dir, { recursive: true, force: true });
