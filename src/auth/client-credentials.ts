import fs from 'node:fs/promises';
import path from 'node:path';
import { AuthError, UsageError } from '../errors/errors.js';
import { getPaths } from '../config/paths.js';
import { expandHome, pathExists } from '../utils/fs.js';

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret?: string;
  /** Where the credentials came from, for `auth status` (never includes the secret). */
  source: 'env' | 'file' | 'flags';
  file?: string;
}

interface ClientSecretJson {
  installed?: { client_id?: string; client_secret?: string };
  web?: { client_id?: string; client_secret?: string };
  client_id?: string;
  client_secret?: string;
}

export async function readClientSecretFile(file: string): Promise<OAuthClientCredentials> {
  const resolved = path.resolve(expandHome(file));
  let data: ClientSecretJson;
  try {
    data = JSON.parse(await fs.readFile(resolved, 'utf8')) as ClientSecretJson;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UsageError(`OAuth client file not found: ${resolved}`);
    }
    throw new UsageError(`OAuth client file is not valid JSON: ${resolved}`, { cause: err });
  }
  const block = data.installed ?? data.web ?? data;
  if (!block.client_id) {
    throw new UsageError(`No client_id found in ${resolved}.`, {
      hint: 'Download the JSON for a "Desktop app" OAuth client from Google Cloud Console.',
    });
  }
  if (data.web && !data.installed) {
    throw new UsageError(`${resolved} is a "Web application" OAuth client.`, {
      hint: 'Create an OAuth client of type "Desktop app" — it allows the loopback redirect gvids uses.',
    });
  }
  return {
    clientId: block.client_id,
    ...(block.client_secret ? { clientSecret: block.client_secret } : {}),
    source: 'file',
    file: resolved,
  };
}

export interface ResolveClientOptions {
  env?: NodeJS.ProcessEnv;
  /** --client-id / --client-secret flags. */
  clientId?: string;
  clientSecret?: string;
  /** --client-secret-file flag or auth.clientSecretFile config. */
  clientSecretFile?: string;
}

/**
 * Resolution order: explicit flags > GOOGLE_CLIENT_ID/SECRET (or GVIDS_*) >
 * --client-secret-file / config > ~/.gvids/client_secret.json.
 */
export async function resolveClientCredentials(
  options: ResolveClientOptions = {},
): Promise<OAuthClientCredentials | undefined> {
  const env = options.env ?? process.env;
  if (options.clientId) {
    return {
      clientId: options.clientId,
      ...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
      source: 'flags',
    };
  }
  const envId = env.GOOGLE_CLIENT_ID ?? env.GVIDS_CLIENT_ID;
  if (envId) {
    const envSecret = env.GOOGLE_CLIENT_SECRET ?? env.GVIDS_CLIENT_SECRET;
    return { clientId: envId, ...(envSecret ? { clientSecret: envSecret } : {}), source: 'env' };
  }
  if (options.clientSecretFile) return readClientSecretFile(options.clientSecretFile);
  const defaultFile = getPaths(env).clientSecretFile;
  if (await pathExists(defaultFile)) return readClientSecretFile(defaultFile);
  return undefined;
}

export async function requireClientCredentials(
  options: ResolveClientOptions = {},
): Promise<OAuthClientCredentials> {
  const creds = await resolveClientCredentials(options);
  if (!creds) {
    throw new AuthError('No Google OAuth client is configured.', {
      code: 'OAUTH_CLIENT_MISSING',
      hint: [
        'Create a "Desktop app" OAuth client in Google Cloud Console (see docs/authentication.md), then either:',
        `  save its JSON as ${getPaths(options.env).clientSecretFile}`,
        '  or run: gvids auth login --client-secret-file path/to/client_secret.json',
        '  or set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
      ],
    });
  }
  return creds;
}

/** Copies a client_secret.json into ~/.gvids so later commands find it automatically. */
export async function importClientSecretFile(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  await readClientSecretFile(file); // validate first
  const target = getPaths(env).clientSecretFile;
  const source = path.resolve(expandHome(file));
  if (path.resolve(target) !== source) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    await fs.chmod(target, 0o600).catch(() => undefined);
  }
  return target;
}
