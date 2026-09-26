import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DriveService } from '../../src/google/drive.js';
import { downloadRendered, downloadThumbnail } from '../../src/google/downloads.js';
import { buildOrderBy, buildVidsQuery, escapeQueryValue } from '../../src/google/files.js';
import { parseRole, PermissionsService } from '../../src/google/permissions.js';
import { ApiError, FakeDriveTransport, fixture } from '../helpers/fake-drive.js';
import { tempHome } from '../helpers/cli.js';

const VID1 = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789vid1';
const VID2 = '1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210vid2';
const FOLDER = '0AFolderTargetFolderTargetFolderTarget01';

describe('query building', () => {
  it('always filters to Vids and non-trashed files', () => {
    expect(buildVidsQuery()).toBe("mimeType='application/vnd.google-apps.vid' and trashed=false");
  });

  it('combines filters and escapes quotes', () => {
    const q = buildVidsQuery({
      name: "Kid's video",
      folderId: 'F1',
      modifiedAfter: '2026-09-01T00:00:00.000Z',
      owner: 'me',
      starred: true,
    });
    expect(q).toBe(
      "mimeType='application/vnd.google-apps.vid' and trashed=false and name contains 'Kid\\'s video' and 'F1' in parents and modifiedTime > '2026-09-01T00:00:00.000Z' and 'me' in owners and starred=true",
    );
    expect(escapeQueryValue("a\\b'c")).toBe("a\\\\b\\'c");
  });

  it('validates owners', () => {
    expect(() => buildVidsQuery({ owner: 'not an email' })).toThrow(/--owner/);
    expect(buildVidsQuery({ owner: 'a@b.co' })).toContain("'a@b.co' in owners");
  });

  it('builds orderBy', () => {
    expect(buildOrderBy()).toBe('modifiedTime desc');
    expect(buildOrderBy('name', true)).toBe('name');
    expect(buildOrderBy('createdTime', true)).toBe('createdTime');
  });
});

describe('DriveService', () => {
  it('lists Vids across pages up to the limit', async () => {
    const t = new FakeDriveTransport();
    t.pageSize = 1;
    const drive = new DriveService(t);
    const all = await drive.list({ limit: 10 });
    expect(all.files.map((f) => f.id)).toEqual([VID1, VID2]);
    expect(all.truncated).toBe(false);
    expect(t.calls.filter((c) => c.method === 'listFiles')).toHaveLength(2);
    const one = await drive.list({ limit: 1 });
    expect(one.files).toHaveLength(1);
    expect(one.truncated).toBe(true);
  });

  it('normalizes file metadata', async () => {
    const drive = new DriveService(new FakeDriveTransport());
    const file = await drive.get(VID1);
    expect(file).toMatchObject({
      id: VID1,
      name: 'Biology: Photosynthesis',
      owners: [{ name: 'Test User', email: 'owner@example.com', me: true }],
      shared: true,
      capabilities: { canEdit: true, canRename: true },
    });
  });

  it('resolves shortcuts to the target Vid', async () => {
    const drive = new DriveService(new FakeDriveTransport());
    expect((await drive.get('1ShortcutToVid1ShortcutToVid1Shortcut00001')).id).toBe(VID1);
  });

  it('refuses non-Vids files for mutations', async () => {
    const drive = new DriveService(new FakeDriveTransport());
    await expect(drive.rename('1DocNotAVidDocNotAVidDocNotAVidDocNot0001', 'x')).rejects.toMatchObject({
      code: 'NOT_A_VID',
    });
    expect(
      (await drive.get('1DocNotAVidDocNotAVidDocNotAVidDocNot0001', { requireVid: false })).mimeType,
    ).toContain('document');
  });

  it('maps 404 to VIDS_NOT_FOUND with the ID', async () => {
    const drive = new DriveService(new FakeDriveTransport());
    await expect(drive.get('1MissingMissingMissingMissing00000')).rejects.toMatchObject({
      code: 'VIDS_NOT_FOUND',
      exitCode: 5,
    });
  });

  it('renames, copies, moves, trashes, restores and deletes', async () => {
    const t = new FakeDriveTransport();
    const drive = new DriveService(t);
    expect((await drive.rename(VID1, '  CLI Test ')).name).toBe('CLI Test');
    await expect(drive.rename(VID1, '  ')).rejects.toThrow(/must not be empty/);
    const copy = await drive.copy(VID1, { name: 'My copy', folderId: FOLDER });
    expect(copy).toMatchObject({ name: 'My copy', parents: [FOLDER] });
    expect((await drive.copy(VID1)).name).toBe('Copy of CLI Test');
    const moved = await drive.move(VID1, FOLDER);
    expect(moved.parents).toEqual([FOLDER]);
    const upd = t.calls.filter((c) => c.method === 'updateFile').at(-1)!;
    expect(upd.args[2]).toMatchObject({ addParents: FOLDER, removeParents: '0AFolderRootXYZ' });
    expect((await drive.setTrashed(VID1, true)).trashed).toBe(true);
    expect((await drive.setTrashed(VID1, false)).trashed).toBe(false);
    await drive.deletePermanently(VID1);
    expect(t.files.find((f) => f.id === VID1)).toBeUndefined();
  });

  it('respects capabilities before renaming', async () => {
    const drive = new DriveService(new FakeDriveTransport());
    await expect(drive.rename(VID2, 'x')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('refuses to move into a non-folder', async () => {
    const drive = new DriveService(new FakeDriveTransport());
    await expect(drive.move(VID1, VID2)).rejects.toThrow(/not a Drive folder/);
  });

  it('maps API errors from the transport', async () => {
    const t = new FakeDriveTransport();
    t.failNext = new ApiError(403, 'userRateLimitExceeded', 'slow down');
    await expect(new DriveService(t).list()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('MP4 download (files.download long-running operation)', () => {
  it('polls until done, then streams the download URI to disk', async () => {
    const t = new FakeDriveTransport();
    t.operations = [
      fixture('drive/operation-pending.json'),
      fixture('drive/operation-pending.json'),
      fixture('drive/operation-done.json'),
    ];
    const dir = tempHome();
    const phases: string[] = [];
    const result = await downloadRendered(t, VID1, path.join(dir, 'out.mp4'), {
      pollIntervalMs: 5,
      timeoutMs: 5000,
      onProgress: (p) => phases.push(p.phase),
    });
    expect(fs.readFileSync(result.path, 'utf8')).toBe('fake mp4 bytes');
    expect(result.bytes).toBe(14);
    expect(result.operation).toBe('operations/download-abc123');
    expect(t.calls.filter((c) => c.method === 'getOperation')).toHaveLength(2);
    expect(t.calls.find((c) => c.method === 'startDownload')!.args[1]).toMatchObject({
      mimeType: 'video/mp4',
    });
    expect(phases[0]).toBe('requesting');
    expect(phases).toContain('rendering');
    expect(phases).toContain('downloading');
    expect(phases.at(-1)).toBe('done');
    expect(fs.existsSync(`${result.path}.gvids-part`)).toBe(false);
  });

  it('does not poll when the first response is already done', async () => {
    const t = new FakeDriveTransport();
    t.operations = [fixture('drive/operation-done.json')];
    await downloadRendered(t, VID1, path.join(tempHome(), 'a.mp4'), { pollIntervalMs: 5, timeoutMs: 1000 });
    expect(t.calls.filter((c) => c.method === 'getOperation')).toHaveLength(0);
  });

  it('surfaces render errors', async () => {
    const t = new FakeDriveTransport();
    t.operations = [fixture('drive/operation-pending.json'), fixture('drive/operation-error.json')];
    await expect(
      downloadRendered(t, VID1, path.join(tempHome(), 'b.mp4'), { pollIntervalMs: 5, timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      code: 'DOWNLOAD_ERROR',
    });
  });

  it('times out with GENERATION_TIMEOUT', async () => {
    const t = new FakeDriveTransport();
    t.operations = Array.from({ length: 50 }, () => fixture('drive/operation-pending.json'));
    await expect(
      downloadRendered(t, VID1, path.join(tempHome(), 'c.mp4'), { pollIntervalMs: 5, timeoutMs: 40 }),
    ).rejects.toMatchObject({
      code: 'GENERATION_TIMEOUT',
      exitCode: 8,
    });
  });

  it('refuses to overwrite unless asked', async () => {
    const dir = tempHome();
    const target = path.join(dir, 'exists.mp4');
    fs.writeFileSync(target, 'old');
    const t = new FakeDriveTransport();
    await expect(
      downloadRendered(t, VID1, target, { pollIntervalMs: 5, timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/already exists/),
      hint: [expect.stringMatching(/--overwrite/)],
    });
    await downloadRendered(t, VID1, target, { pollIntervalMs: 5, timeoutMs: 1000, overwrite: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('fake mp4 bytes');
  });

  it('downloads thumbnails at a requested size', async () => {
    const t = new FakeDriveTransport();
    const r = await downloadThumbnail(
      t,
      'https://lh3.googleusercontent.com/drive-storage/thumb=s220',
      path.join(tempHome(), 't.png'),
      { size: 1280 },
    );
    expect(r.bytes).toBe(4);
    expect(t.calls.at(-1)!.args[0]).toBe('https://lh3.googleusercontent.com/drive-storage/thumb=s1280');
  });
});

describe('permissions', () => {
  it('parses role aliases', () => {
    expect(parseRole('editor')).toBe('writer');
    expect(parseRole('Viewer')).toBe('reader');
    expect(parseRole('commenter')).toBe('commenter');
    expect(() => parseRole('owner')).toThrow(/Unknown role/);
  });

  it('creates, updates idempotently and removes permissions', async () => {
    const t = new FakeDriveTransport();
    const perms = new PermissionsService(t);
    const created = await perms.share(VID1, { kind: 'user', email: 'new@example.com' }, 'writer', {
      notify: false,
      message: 'hi',
    });
    expect(created.action).toBe('created');
    expect(t.calls.find((c) => c.method === 'createPermission')!.args[2]).toMatchObject({
      sendNotificationEmail: false,
      emailMessage: 'hi',
    });
    expect((await perms.share(VID1, { kind: 'user', email: 'NEW@example.com' }, 'writer')).action).toBe(
      'unchanged',
    );
    expect((await perms.share(VID1, { kind: 'user', email: 'reader@example.com' }, 'commenter')).action).toBe(
      'updated',
    );
    const anyone = await perms.share(VID1, { kind: 'anyone' }, 'reader');
    expect(anyone.permission).toMatchObject({ type: 'anyone', role: 'reader', allowFileDiscovery: false });
    const removed = await perms.unshare(VID1, { kind: 'anyone' });
    expect(removed).toHaveLength(1);
    await expect(perms.unshare(VID1, { kind: 'user', email: 'ghost@example.com' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(perms.unshare(VID1, { kind: 'user', email: 'owner@example.com' })).rejects.toThrow(
      /owner permission/,
    );
  });
});
