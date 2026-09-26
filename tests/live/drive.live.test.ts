/**
 * Live Google Drive API tests. Opt-in: GVIDS_LIVE=1, plus an OAuth login
 * (`gvids auth login`) and a signed-in gvids browser (to create the test video).
 * Without an OAuth login every test here is reported as SKIPPED, never as passed.
 *
 * Everything touched is created by the suite: one video ("gvids drive live test …"),
 * a copy of it and a folder. The copy and the folder are deleted and the video is
 * moved to the trash at the end.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DriveTransport } from '../../src/google/transport.js';
import { invokeCli } from '../../src/mcp/server.js';

const LIVE = process.env.GVIDS_LIVE === '1';
const run = (args: string[]) => invokeCli([...args, '--headless']);
type Env = { ok: boolean; data: any; error: any; warnings?: string[] } | undefined;
const env = (r: { envelope: unknown }): Env => r.envelope as Env;

/** The raw Drive transport, for test resources gvids itself does not manage (folders). */
async function driveTransport(): Promise<DriveTransport> {
  const { ConfigStore } = await import('../../src/config/config.js');
  const { getPaths } = await import('../../src/config/paths.js');
  const { AuthManager } = await import('../../src/auth/oauth.js');
  const { GoogleDriveTransport } = await import('../../src/google/transport.js');
  const { silentLogger } = await import('../../src/utils/logger.js');
  const paths = getPaths(process.env);
  const config = await new ConfigStore(paths.configFile).load();
  const auth = new AuthManager({ config, paths, env: process.env, logger: silentLogger() });
  return new GoogleDriveTransport(await auth.getClient());
}

describe.skipIf(!LIVE)('live: Google Drive API', () => {
  let signedIn = false;
  let id = '';
  let copyId = '';
  let folderId = '';
  const title = `gvids drive live test ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gvids-drive-live-'));

  beforeAll(async () => {
    signedIn = env(await run(['auth', 'status']))?.ok === true;
    if (!signedIn) return;
    const created = env(await run(['create', title]));
    if (!created?.ok) throw new Error(`Could not create the test video: ${JSON.stringify(created?.error)}`);
    id = created.data.id;
  });

  afterAll(async () => {
    fs.rmSync(outDir, { recursive: true, force: true });
    const warn = (what: string, r: Awaited<ReturnType<typeof run>>) => {
      if (!env(r)?.ok) console.warn(`Could not clean up ${what}: ${JSON.stringify(env(r)?.error)}`);
    };
    if (copyId) warn(`copy ${copyId}`, await run(['delete', copyId, '--yes']));
    if (id) warn(`test video ${id}`, await run(['trash', id, '--yes']));
    if (folderId) {
      const drive = await driveTransport();
      await drive
        .deleteFile(folderId)
        .catch((e: unknown) => console.warn(`Could not delete test folder ${folderId}: ${String(e)}`));
    }
  });

  it('lists and searches through the API', async (ctx) => {
    if (!signedIn) ctx.skip('no OAuth login (run: gvids auth login)');
    const list = env(await run(['list', '--limit', '5', '--order-by', 'modifiedTime']));
    expect(list?.data.method).toBe('drive-api');
    const found = env(await run(['search', title, '--owner', 'me']));
    expect(found?.data.files.map((f: { id: string }) => f.id)).toContain(id);
    const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(env(await run(['search', '--modified-after', since]))?.ok).toBe(true);
  });

  it('reads metadata and permissions', async (ctx) => {
    if (!signedIn) ctx.skip('no OAuth login');
    const info = env(await run(['info', id]));
    expect(info?.data).toMatchObject({ id, name: title, mimeType: 'application/vnd.google-apps.vid' });
    const perms = env(await run(['permissions', id]));
    expect(perms?.data.permissions.some((p: { role: string }) => p.role === 'owner')).toBe(true);
  });

  it('renames, copies, moves and deletes the copy', async (ctx) => {
    if (!signedIn) ctx.skip('no OAuth login');
    expect(env(await run(['rename', id, `${title} (renamed)`]))?.data.name).toBe(`${title} (renamed)`);
    const copy = env(await run(['copy', id, '--name', `${title} (copy)`]));
    copyId = copy?.data.id;
    expect(copyId).toBeTruthy();
    const folder = await (
      await driveTransport()
    ).createFile({ name: `${title} folder`, mimeType: 'application/vnd.google-apps.folder' }, 'id');
    folderId = folder.id!;
    expect(env(await run(['move', copyId, folderId]))?.data.parents).toContain(folderId);
    expect(env(await run(['delete', copyId]))?.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(env(await run(['delete', copyId, '--yes']))?.data.deleted).toBe(true);
    copyId = '';
  });

  it('shares publicly only with --yes, and unshares', async (ctx) => {
    if (!signedIn) ctx.skip('no OAuth login');
    expect(env(await run(['share', id, '--anyone', 'reader']))?.error.code).toBe('CONFIRMATION_REQUIRED');
    const shared = env(await run(['share', id, '--anyone', 'reader', '--yes']));
    expect(shared?.data.permission.type).toBe('anyone');
    expect(env(await run(['unshare', id, '--anyone']))?.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(env(await run(['unshare', id, '--anyone', '--yes']))?.data.removed[0].type).toBe('anyone');
  });

  it('renders an MP4 with files.download and fetches the thumbnail', async (ctx) => {
    if (!signedIn) ctx.skip('no OAuth login');
    const mp4 = path.join(outDir, 'drive.mp4');
    const dl = env(await run(['download', id, mp4, '--timeout', '20m']));
    expect(dl?.data).toMatchObject({ method: 'drive-api', path: mp4 });
    expect(fs.readFileSync(mp4).subarray(4, 8).toString('latin1')).toBe('ftyp');
    const thumb = env(await run(['thumbnail', id, path.join(outDir, 'thumb.png')]));
    // A brand-new video may not have a thumbnail yet; either outcome must be a clean envelope.
    expect(thumb?.ok || thumb?.error.code === 'INVALID_ARGUMENT').toBe(true);
  });

  it('trashes and restores through the API', async (ctx) => {
    if (!signedIn) ctx.skip('no OAuth login');
    expect(env(await run(['trash', id, '--yes']))?.data).toMatchObject({
      trashed: true,
      method: 'drive-api',
    });
    const trashed = env(await run(['list', '--trashed', '--limit', '50']));
    expect(trashed?.data.files.some((f: { id: string }) => f.id === id)).toBe(true);
    expect(env(await run(['restore', id]))?.data).toMatchObject({ trashed: false });
  });
});
