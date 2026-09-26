import os from 'node:os';
import path from 'node:path';

/**
 * All on-disk locations used by gvids. Everything lives under one directory
 * (default ~/.gvids, override with GVIDS_HOME) so it is easy to inspect or wipe.
 */
export interface GvidsPaths {
  home: string;
  configFile: string;
  credentialsDir: string;
  tokenFile: string;
  tokenStoreMarker: string;
  clientSecretFile: string;
  browserDir: string;
  browserProfileDir: string;
  browserStateFile: string;
  jobsDir: string;
  /** Background tasks started with --detach. */
  tasksDir: string;
  cacheDir: string;
  capabilitiesCacheFile: string;
  templatesCacheFile: string;
  logsDir: string;
  /** Default place for failure screenshots, accessibility snapshots and traces. */
  debugDir: string;
}

export function resolveHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GVIDS_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.gvids');
}

export function getPaths(env: NodeJS.ProcessEnv = process.env): GvidsPaths {
  const home = resolveHomeDir(env);
  const credentialsDir = path.join(home, 'credentials');
  const browserDir = path.join(home, 'browser');
  const cacheDir = path.join(home, 'cache');
  return {
    home,
    configFile: path.join(home, 'config.json'),
    credentialsDir,
    tokenFile: path.join(credentialsDir, 'tokens.json'),
    tokenStoreMarker: path.join(credentialsDir, 'store.json'),
    clientSecretFile: path.join(home, 'client_secret.json'),
    browserDir,
    browserProfileDir: path.join(browserDir, 'profile'),
    browserStateFile: path.join(browserDir, 'state.json'),
    jobsDir: path.join(home, 'jobs'),
    tasksDir: path.join(home, 'tasks'),
    cacheDir,
    capabilitiesCacheFile: path.join(cacheDir, 'capabilities.json'),
    templatesCacheFile: path.join(cacheDir, 'templates.json'),
    logsDir: path.join(home, 'logs'),
    debugDir: path.join(home, 'debug'),
  };
}
