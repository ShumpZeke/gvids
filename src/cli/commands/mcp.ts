import type { Command } from 'commander';
import { action, type Kit } from '../kit.js';

export function registerMcpCommand(program: Command, kit: Kit): void {
  program
    .command('mcp')
    .description('Run gvids as an MCP server over stdio (for Claude Code, Codex, other MCP clients)')
    .addHelpText(
      'after',
      [
        '',
        'Register with Claude Code:',
        '  claude mcp add gvids -- gvids mcp',
        'Generic MCP client config:',
        '  { "mcpServers": { "gvids": { "command": "gvids", "args": ["mcp"] } } }',
        '',
        'Tools map 1:1 to CLI commands and return the same { ok, data, error } envelopes.',
      ].join('\n'),
    )
    .action(
      action(kit, async () => {
        const { startMcpServer } = await import('../../mcp/server.js');
        await startMcpServer();
      }),
    );
}
