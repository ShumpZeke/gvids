import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { RuntimeIO, ServiceOverrides } from '../../src/cli/context.js';
import { BrowserLoginRequiredError } from '../../src/errors/errors.js';
import { runCli } from '../../src/cli/program.js';
import type { FakeDriveTransport } from './fake-drive.js';

class Capture extends Writable {
  data = '';
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    this.data += chunk.toString();
    cb();
  }
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  json: { ok: boolean; data: any; error: any; warnings?: string[] } | undefined;
}

export function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gvids-test-'));
}

export async function cli(
  args: string[],
  options: {
    drive?: FakeDriveTransport;
    home?: string;
    stdin?: string;
    overrides?: ServiceOverrides;
    env?: Record<string, string>;
    cwd?: string;
  } = {},
): Promise<CliRun> {
  const stdout = new Capture();
  const stderr = new Capture();
  const stdin = new PassThrough();
  stdin.end(options.stdin ?? '');
  const home = options.home ?? tempHome();
  const io: RuntimeIO = {
    stdout,
    stderr,
    stdin,
    env: { GVIDS_HOME: home, NO_COLOR: '1', ...options.env },
    cwd: options.cwd ?? home,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stderrIsTTY: false,
  };
  const drive = options.drive;
  const overrides: ServiceOverrides = {
    ...(drive ? { driveTransport: async () => drive } : {}),
    openUrl: async () => undefined,
    // Unit tests must never start a real browser.
    startBrowserSession: async () => {
      throw new BrowserLoginRequiredError('No browser in unit tests.');
    },
    spawnTask: async () => ({ pid: 999999 }),
    ...options.overrides,
  };
  const code = await runCli(['node', 'gvids', ...args], io, overrides);
  let json: CliRun['json'];
  try {
    json = JSON.parse(stdout.data);
  } catch {
    json = undefined;
  }
  return { code, stdout: stdout.data, stderr: stderr.data, json };
}
