import fs from 'node:fs/promises';
import { AsyncEntry } from '@napi-rs/keyring';
import { AuthError } from '../errors/errors.js';
import type { GvidsPaths } from '../config/paths.js';
import { readJsonFile, writeFileAtomic } from '../utils/fs.js';

/** What gvids persists after `gvids auth login`. Never printed; see redact.ts. */
export interface StoredToken {
  refresh_token?: string;
  access_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
  client_id: string;
  account?: { email?: string; name?: string };
  created_at: string;
}

export type TokenStoreKind = 'keyring' | 'file';

export interface TokenStore {
  readonly kind: TokenStoreKind;
  readonly location: string;
  load(): Promise<StoredToken | undefined>;
  save(token: StoredToken): Promise<void>;
  clear(): Promise<boolean>;
}

const SERVICE = 'gvids';
const ACCOUNT = 'google-oauth-token';

export class KeyringTokenStore implements TokenStore {
  readonly kind = 'keyring' as const;
  readonly location = `OS credential store (service "${SERVICE}", account "${ACCOUNT}")`;
  private readonly entry = new AsyncEntry(SERVICE, ACCOUNT);

  async load(): Promise<StoredToken | undefined> {
    const value = await this.entry.getPassword();
    if (!value) return undefined;
    try {
      return JSON.parse(value) as StoredToken;
    } catch {
      return undefined;
    }
  }

  async save(token: StoredToken): Promise<void> {
    await this.entry.setPassword(JSON.stringify(token));
  }

  async clear(): Promise<boolean> {
    try {
      return await this.entry.deletePassword();
    } catch {
      return false;
    }
  }

  /** Verifies the platform keyring actually works (e.g. Secret Service may be missing on Linux). */
  static async probe(): Promise<boolean> {
    const probe = new AsyncEntry(SERVICE, 'gvids-probe');
    try {
      await probe.setPassword('probe');
      const read = await probe.getPassword();
      await probe.deletePassword().catch(() => false);
      return read === 'probe';
    } catch {
      return false;
    }
  }
}

export class FileTokenStore implements TokenStore {
  readonly kind = 'file' as const;
  constructor(readonly location: string) {}

  async load(): Promise<StoredToken | undefined> {
    return readJsonFile<StoredToken>(this.location);
  }

  async save(token: StoredToken): Promise<void> {
    // 0600: readable only by the current user (on Windows the profile directory ACL applies).
    await writeFileAtomic(this.location, `${JSON.stringify(token, null, 2)}\n`, { mode: 0o600 });
  }

  async clear(): Promise<boolean> {
    try {
      await fs.rm(this.location);
      return true;
    } catch {
      return false;
    }
  }
}

interface Marker {
  store: TokenStoreKind;
}

/**
 * Picks where tokens live. "auto" prefers the OS keyring (Windows Credential
 * Manager, macOS Keychain, Secret Service) and falls back to a 0600 file.
 * The choice is remembered in a non-secret marker file.
 */
export async function selectTokenStore(
  preference: 'auto' | 'keyring' | 'file',
  paths: GvidsPaths,
  options: { forWrite?: boolean } = {},
): Promise<TokenStore> {
  const file = new FileTokenStore(paths.tokenFile);
  if (preference === 'file') return file;
  if (preference === 'keyring') {
    if (!(await KeyringTokenStore.probe())) {
      throw new AuthError('The OS credential store is not available on this system.', {
        code: 'AUTH_REQUIRED',
        hint: 'Use file storage instead: gvids config set auth.tokenStore file',
      });
    }
    return new KeyringTokenStore();
  }
  const marker = await readJsonFile<Marker>(paths.tokenStoreMarker).catch(() => undefined);
  if (marker?.store === 'file') return file;
  if (marker?.store === 'keyring') return new KeyringTokenStore();
  if (!options.forWrite) {
    // Nothing stored yet; reading from either returns nothing. Prefer keyring for consistency.
    return (await KeyringTokenStore.probe()) ? new KeyringTokenStore() : file;
  }
  const store = (await KeyringTokenStore.probe()) ? new KeyringTokenStore() : file;
  await writeFileAtomic(
    paths.tokenStoreMarker,
    `${JSON.stringify({ store: store.kind } satisfies Marker)}\n`,
  );
  return store;
}

export async function clearStoreMarker(paths: GvidsPaths): Promise<void> {
  await fs.rm(paths.tokenStoreMarker, { force: true });
}
