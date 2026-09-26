import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { coerceConfigValue, ConfigStore, CONFIG_KEYS, DEFAULT_CONFIG } from '../../src/config/config.js';
import { getPaths } from '../../src/config/paths.js';
import { tempHome } from '../helpers/cli.js';

describe('config', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_CONFIG.browser.headless).toBe(false);
    expect(DEFAULT_CONFIG.browser.timeout).toBe(120_000);
    expect(DEFAULT_CONFIG.output.format).toBe('json');
    expect(DEFAULT_CONFIG.downloads.directory).toBe('./downloads');
    expect(DEFAULT_CONFIG.auth.scopes).toBe('full');
  });

  it('coerces values by key type', () => {
    expect(coerceConfigValue('browser.headless', 'true')).toBe(true);
    expect(coerceConfigValue('browser.headless', 'off')).toBe(false);
    expect(coerceConfigValue('browser.timeout', '5000')).toBe(5000);
    expect(coerceConfigValue('auth.tokenStore', 'file')).toBe('file');
    expect(() => coerceConfigValue('auth.tokenStore', 'vault')).toThrow(/one of/);
    expect(() => coerceConfigValue('browser.headless', 'maybe')).toThrow(/true or false/);
    expect(() => coerceConfigValue('nope.key', '1')).toThrow(/Unknown configuration key/);
  });

  it('every documented key maps to a real setting', () => {
    for (const key of Object.keys(CONFIG_KEYS)) {
      const [section, name] = key.split('.') as [keyof typeof DEFAULT_CONFIG, string];
      expect(DEFAULT_CONFIG[section], key).toBeDefined();
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it('sets, gets, unsets and persists to ~/.gvids/config.json', async () => {
    const home = tempHome();
    const env = { GVIDS_HOME: home };
    const store = new ConfigStore(getPaths(env).configFile, env);
    await store.load();
    await store.set('browser.headless', 'true');
    await store.set('downloads.directory', './out');
    expect(store.get('browser.headless')).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    expect(onDisk).toEqual({ browser: { headless: true }, downloads: { directory: './out' } });
    expect(store.explicitKeys().sort()).toEqual(['browser.headless', 'downloads.directory']);
    expect(await store.unset('browser.headless')).toBe(true);
    expect(store.get('browser.headless')).toBe(false);
    expect(await store.unset('browser.headless')).toBe(false);
  });

  it('applies environment overrides', async () => {
    const home = tempHome();
    const env = { GVIDS_HOME: home, GVIDS_HEADLESS: '1', GVIDS_OUTPUT: 'text' };
    const config = await new ConfigStore(getPaths(env).configFile, env).load();
    expect(config.browser.headless).toBe(true);
    expect(config.output.format).toBe('text');
  });

  it('reports invalid JSON clearly', async () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, 'config.json'), '{ nope');
    await expect(new ConfigStore(path.join(home, 'config.json'), {}).load()).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('rejects out-of-range values', async () => {
    const home = tempHome();
    const store = new ConfigStore(path.join(home, 'config.json'), {});
    await store.load();
    await expect(store.set('browser.viewportWidth', '100')).rejects.toThrow(/Invalid value/);
  });

  it('validates each key with a message that names it', async () => {
    const home = tempHome();
    const file = path.join(home, 'config.json');
    const cases: Array<[unknown, RegExp]> = [
      [{ browser: { timeout: 'soon' } }, /browser\.timeout: expected a number/],
      [{ browser: { timeout: 1.5 } }, /browser\.timeout: expected a whole number/],
      [{ browser: { viewportWidth: 100 } }, /browser\.viewportWidth: must be at least 800/],
      [{ output: { format: 'xml' } }, /output\.format: expected one of json, text/],
      [{ browser: { headless: 'yes' } }, /browser\.headless: expected true or false/],
      [{ browser: { locale: 'e' } }, /browser\.locale: expected at least 2/],
      [{ browser: 5 }, /browser: expected an object/],
    ];
    for (const [content, message] of cases) {
      fs.writeFileSync(file, JSON.stringify(content));
      await expect(new ConfigStore(file, {}).load(), JSON.stringify(content)).rejects.toThrow(message);
    }
  });

  it('reports unknown keys without failing', async () => {
    const home = tempHome();
    const file = path.join(home, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ browser: { headles: true }, extra: 1 }));
    const store = new ConfigStore(file, {});
    const config = await store.load();
    expect(config.browser.headless).toBe(false);
    expect(store.notices.join(' ')).toMatch(/Unknown config key\(s\) ignored: browser\.headles, extra/);
  });

  it('GVIDS_HOME relocates every path', () => {
    const paths = getPaths({ GVIDS_HOME: path.join('x', 'y') });
    expect(paths.home).toBe(path.resolve('x', 'y'));
    expect(paths.jobsDir).toBe(path.join(path.resolve('x', 'y'), 'jobs'));
    expect(paths.browserProfileDir).toBe(path.join(path.resolve('x', 'y'), 'browser', 'profile'));
  });
});
