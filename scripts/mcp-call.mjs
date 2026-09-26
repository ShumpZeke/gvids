// Calls one gvids MCP tool over stdio and prints the JSON envelope.
// Usage: node scripts/mcp-call.mjs <tool> '<json arguments>'
//   node scripts/mcp-call.mjs vids_scene_list '{"id":"<video-id>"}'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [tool, json = '{}'] = process.argv.slice(2);
if (!tool) {
  console.error("Usage: node scripts/mcp-call.mjs <tool> '<json arguments>'");
  process.exit(2);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist', 'cli', 'index.js'), 'mcp'],
  stderr: 'inherit',
});
const client = new Client({ name: 'gvids-mcp-call', version: '0.0.1' });
await client.connect(transport);
const result = await client.callTool({ name: tool, arguments: JSON.parse(json) });
console.log(result.content.map((c) => c.text).join('\n'));
await client.close();
process.exitCode = result.isError ? 1 : 0;
