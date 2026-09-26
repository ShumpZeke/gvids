// Smoke test for `gvids mcp` from the built package: starts the server over stdio
// with the official MCP client and checks discovery, annotations, envelopes and
// safeguards. Offline: it uses a temporary GVIDS_HOME and never touches Google.
// Usage: node scripts/mcp-smoke.mjs [path/to/gvids/dist/cli/index.js]   (default: this checkout, after pnpm build)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gvids-mcp-smoke-'));
const ID = 'smokeTestVideoId0123456789abcdef';

const entry = path.resolve(process.argv[2] ?? path.join(root, 'dist', 'cli', 'index.js'));
console.log(`gvids: ${entry}`);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry, 'mcp'],
  env: { ...getDefaultEnvironment(), GVIDS_HOME: home },
  stderr: 'pipe',
});
const client = new Client({ name: 'gvids-smoke', version: '0.0.1' });
await client.connect(transport);

let failures = 0;
function check(name, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${condition ? '' : `  ${detail}`}`);
  if (!condition) failures++;
}
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  return { isError: Boolean(r.isError), env: JSON.parse(r.content[0].text) };
}

try {
  const { tools } = await client.listTools();
  check('lists 31 tools', tools.length === 31, `got ${tools.length}`);
  check(
    'every tool has annotations and an input schema',
    tools.every((t) => t.annotations && t.inputSchema?.type === 'object'),
  );
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  check('vids_trash is destructive', byName.vids_trash?.annotations?.destructiveHint === true);
  check('vids_list is read-only', byName.vids_list?.annotations?.readOnlyHint === true);
  check('generic gvids tool is not read-only', byName.gvids?.annotations?.readOnlyHint === false);

  const open = await call('vids_open', { id: ID });
  check('vids_open returns the editor URL', open.env.ok && open.env.data.url.endsWith(`/d/${ID}/edit`));

  const listed = await call('vids_commands', { prefix: ['scene'] });
  check('vids_commands filters by prefix', listed.env.ok && listed.env.data.count === 8);

  const plan = await call('gvids', { args: ['scene', 'delete', ID, '2', '--dry-run'] });
  check(
    'dry-run describes a destructive command and needs approval',
    plan.env.ok && plan.env.data.effect === 'destructive' && plan.env.data.requiresUserApproval === true,
  );

  const refused = await call('gvids', { args: ['config', 'reset'] });
  check(
    'destructive commands need --yes through MCP too',
    refused.isError && refused.env.error.code === 'CONFIRMATION_REQUIRED',
  );
  const approved = await call('gvids', { args: ['config', 'reset', '--yes'] });
  check('--yes runs it', approved.env.ok === true);

  for (const args of [['mcp'], ['--yes', 'mcp'], ['--human', 'mcp']]) {
    const nested = await call('gvids', { args });
    check(`refuses ${JSON.stringify(args)}`, nested.isError && nested.env.error.code === 'INVALID_ARGUMENT');
  }
  const person = await call('gvids', { args: ['browser', 'login'] });
  check(
    'hands person-only commands back to the user',
    person.isError && person.env.error.code === 'USER_ACTION_REQUIRED' && person.env.error.needsUser,
  );

  const bad = await call('vids_get', { id: 'https://example.com/nope' });
  check('errors come back as error envelopes', bad.isError && bad.env.error.code === 'INVALID_ARGUMENT');

  const waited = await call('vids_wait', { id: 'task_20200101000000_abcdef' });
  check('vids_wait reports unknown tasks', waited.isError && waited.env.error.code === 'TASK_NOT_FOUND');

  const batch = await call('gvids', {
    args: ['batch'],
    stdin: JSON.stringify([['url', ID], ['version']]),
  });
  check('batch runs through MCP', batch.env.ok && batch.env.data.succeeded === 2);
} finally {
  await client.close();
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(failures === 0 ? '\nMCP smoke test passed.' : `\n${failures} MCP smoke check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
