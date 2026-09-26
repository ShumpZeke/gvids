import { readFileSync } from 'node:fs';

interface PackageJson {
  name: string;
  version: string;
}

function readPackageJson(): PackageJson {
  // Works from both src/ (tsx) and dist/ (compiled): package.json is one level up.
  const url = new URL('../package.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as PackageJson;
}

const pkg = readPackageJson();

export const PACKAGE_NAME = pkg.name;
export const VERSION = pkg.version;
