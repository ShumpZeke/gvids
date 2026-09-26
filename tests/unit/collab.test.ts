import { describe, expect, it } from 'vitest';
import { parsePersonRow } from '../../src/browser/pages/sharing.js';
import { CollaborationService } from '../../src/google/collaboration.js';
import { DriveService } from '../../src/google/drive.js';
import { shouldRetryDriveRequest } from '../../src/google/transport.js';
import { cli } from '../helpers/cli.js';
import { FakeDriveTransport } from '../helpers/fake-drive.js';

const VID1 = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789vid1';

describe('Drive retry policy', () => {
  const err = (status: number | undefined, reason?: string, method = 'GET', attempt = 0) => ({
    config: { method, retryConfig: { retry: 5, currentRetryAttempt: attempt, noResponseRetries: 2 } },
    ...(status ? { response: { status, data: { error: { errors: reason ? [{ reason }] : [] } } } } : {}),
  });

  it('retries rate limits reported as 403, 429 and 5xx, but not other 403s', () => {
    expect(shouldRetryDriveRequest(err(403, 'rateLimitExceeded'))).toBe(true);
    expect(shouldRetryDriveRequest(err(403, 'userRateLimitExceeded'))).toBe(true);
    expect(shouldRetryDriveRequest(err(429))).toBe(true);
    expect(shouldRetryDriveRequest(err(503))).toBe(true);
    expect(shouldRetryDriveRequest(err(403, 'insufficientFilePermissions'))).toBe(false);
    expect(shouldRetryDriveRequest(err(404, 'notFound'))).toBe(false);
  });

  it('never retries non-idempotent calls and stops after the configured attempts', () => {
    expect(shouldRetryDriveRequest(err(429, undefined, 'POST'))).toBe(false);
    expect(shouldRetryDriveRequest(err(429, undefined, 'GET', 5))).toBe(false);
    expect(shouldRetryDriveRequest(err(undefined, undefined, 'GET', 1))).toBe(true);
    expect(shouldRetryDriveRequest(err(undefined, undefined, 'GET', 2))).toBe(false);
  });
});

describe('comments and versions', () => {
  it('adds, replies to and resolves a comment; resolving twice changes nothing', async () => {
    const drive = new FakeDriveTransport();
    const svc = new CollaborationService(drive);
    const c = await svc.add(VID1, '  Tighten scene 3  ');
    expect(c).toMatchObject({ content: 'Tighten scene 3', resolved: false });
    const r = await svc.reply(VID1, c.id, 'On it');
    expect(r.content).toBe('On it');
    expect((await svc.setResolved(VID1, c.id, true, 'done')).changed).toBe(true);
    expect((await svc.setResolved(VID1, c.id, true)).changed).toBe(false);
    expect(await svc.comments(VID1)).toEqual([]);
    const all = await svc.comments(VID1, { includeResolved: true });
    expect(all[0]).toMatchObject({
      resolved: true,
      replies: [{ content: 'On it' }, { content: 'done', action: 'resolve' }],
    });
    await expect(svc.reply(VID1, 'nope', 'x')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.add(VID1, '   ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('lists versions through the CLI', async () => {
    const drive = new FakeDriveTransport();
    drive.revisions.set(VID1, [
      { id: '1', modifiedTime: '2026-09-22T21:39:51.143Z', lastModifyingUser: { displayName: 'Ann' } },
      { id: '5', modifiedTime: '2026-09-22T21:46:59.555Z' },
    ]);
    const r = await cli(['versions', 'list', VID1], { drive });
    expect(r.code).toBe(0);
    expect(r.json?.data).toMatchObject({ count: 2, versions: [{ id: '1', modifiedBy: 'Ann' }, { id: '5' }] });
  });

  it('comments commands work end to end', async () => {
    const drive = new FakeDriveTransport();
    const added = await cli(['comments', 'add', VID1, 'Looks good'], { drive });
    expect(added.json?.data.comment).toMatchObject({ content: 'Looks good' });
    const id = added.json?.data.comment.id as string;
    expect((await cli(['comments', 'resolve', VID1, id], { drive })).json?.data.changed).toBe(true);
    expect((await cli(['comments', 'list', VID1], { drive })).json?.data.count).toBe(0);
    expect((await cli(['comments', 'list', VID1, '--all'], { drive })).json?.data.count).toBe(1);
  });
});

describe('folders by name', () => {
  it('finds exactly one folder, or says why not', async () => {
    const svc = new DriveService(new FakeDriveTransport());
    expect(await svc.folderIdByName('Target folder')).toBe('0AFolderTargetFolderTargetFolderTarget01');
    expect(await svc.folderIdByName('My Drive')).toBe('root');
    await expect(svc.folderIdByName('Nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('move --folder-name resolves the folder through the Drive API', async () => {
    const drive = new FakeDriveTransport();
    const r = await cli(['move', VID1, '--folder-name', 'Target folder'], { drive });
    expect(r.code).toBe(0);
    expect(r.json?.data.parents).toContain('0AFolderTargetFolderTargetFolderTarget01');
    const both = await cli(['move', VID1, 'root', '--folder-name', 'Target folder'], { drive });
    expect(both.json?.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('share dialog rows', () => {
  it('parses people rows into Drive-shaped permissions', () => {
    expect(parsePersonRow('Ann Lee (you) Ann Lee (you). ann@example.com. Owner.')).toMatchObject({
      id: 'ui:ann@example.com',
      role: 'owner',
      emailAddress: 'ann@example.com',
      displayName: 'Ann Lee',
    });
    expect(parsePersonRow('Bo Chan Bo Chan. bo@example.org. Editor.')).toMatchObject({
      role: 'writer',
      displayName: 'Bo Chan',
    });
    expect(parsePersonRow('Viewer only row without mail')).toBeUndefined();
  });
});

describe('--no-drive-api', () => {
  it('skips the Drive API and says so when falling back to the browser', async () => {
    const drive = new FakeDriveTransport();
    const r = await cli(['permissions', VID1, '--no-drive-api'], { drive });
    // Unit tests have no browser: the fallback fails, but only after the warning.
    expect(r.json?.error.code).toBe('LOGIN_REQUIRED');
    expect(r.json?.warnings?.join(' ')).toMatch(/Drive API turned off; reading who has access/);
    expect(drive.calls.filter((c) => c.method === 'listPermissions')).toEqual([]);
    const env = await cli(['permissions', VID1], { drive, env: { GVIDS_DRIVE_API: 'off' } });
    expect(env.json?.warnings?.join(' ')).toMatch(/Drive API turned off/);
  });

  it('commands without a fallback report that the API is off', async () => {
    const r = await cli(['versions', 'list', VID1, '--no-drive-api'], { drive: new FakeDriveTransport() });
    expect(r.json?.error).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(r.json?.error.message).toMatch(/turned off/);
  });
});
