import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { Logger } from '../../utils/logger.js';
import { redactPersonal } from '../../utils/redact.js';

const SAFE_QUERY_PARAMS = new Set(['hl', 'scene', 'usp', 'authuser']);

/** Removes query parameters that could carry tokens or personal data. */
export function sanitizeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (!SAFE_QUERY_PARAMS.has(key)) url.searchParams.set(key, '…');
    }
    url.hash = url.hash ? '#…' : '';
    return url.toString();
  } catch {
    return redactPersonal(raw);
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export interface FailureCapture {
  dir: string;
  files: string[];
}

/**
 * Collects console errors and failed requests while a browser command runs,
 * and snapshots the page (screenshot + sanitized accessibility tree) when an
 * automation step fails. Everything goes to the debug directory.
 */
export class Diagnostics {
  readonly consoleErrors: string[] = [];
  readonly networkFailures: string[] = [];

  constructor(
    readonly dir: string,
    private readonly verbose: boolean,
    private readonly logger: Logger,
  ) {}

  attach(page: Page): void {
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = redactPersonal(msg.text()).slice(0, 500);
      if (this.consoleErrors.length < 200) this.consoleErrors.push(text);
    });
    page.on('requestfailed', (req) => {
      const failure = req.failure()?.errorText ?? 'failed';
      if (failure === 'net::ERR_ABORTED') return; // navigation noise
      if (this.networkFailures.length < 200) {
        this.networkFailures.push(`${req.method()} ${sanitizeUrl(req.url())} — ${failure}`);
      }
    });
  }

  async captureFailure(
    page: Page | undefined,
    label: string,
    error?: unknown,
  ): Promise<FailureCapture | undefined> {
    const base = path.join(this.dir, `${stamp()}-${label.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}`);
    const files: string[] = [];
    try {
      await fs.mkdir(this.dir, { recursive: true });
      if (page && !page.isClosed()) {
        await page
          .screenshot({ path: `${base}.png`, timeout: 10_000 })
          .then(() => files.push(`${base}.png`))
          .catch(() => undefined);
        const aria = await page
          .locator('body')
          .ariaSnapshot({ timeout: 10_000 })
          .catch(() => undefined);
        if (aria) {
          await fs.writeFile(`${base}.aria.yml`, redactPersonal(aria), 'utf8');
          files.push(`${base}.aria.yml`);
        }
      }
      const summary = {
        label,
        time: new Date().toISOString(),
        url: page && !page.isClosed() ? sanitizeUrl(page.url()) : undefined,
        title: page && !page.isClosed() ? redactPersonal(await page.title().catch(() => '')) : undefined,
        error:
          error instanceof Error
            ? redactPersonal(error.message)
            : error
              ? redactPersonal(String(error))
              : undefined,
        consoleErrors: this.consoleErrors.slice(-30),
        networkFailures: this.networkFailures.slice(-30),
      };
      await fs.writeFile(`${base}.json`, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
      files.push(`${base}.json`);
      return { dir: this.dir, files };
    } catch (err) {
      this.logger.debug({ err: String(err) }, 'could not write diagnostics');
      return files.length > 0 ? { dir: this.dir, files } : undefined;
    }
  }

  async flush(): Promise<string | undefined> {
    if (!this.verbose || (this.consoleErrors.length === 0 && this.networkFailures.length === 0))
      return undefined;
    await fs.mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${stamp()}-session-log.json`);
    await fs.writeFile(
      file,
      `${JSON.stringify({ consoleErrors: this.consoleErrors, networkFailures: this.networkFailures }, null, 2)}\n`,
      'utf8',
    );
    return file;
  }
}
