import { Argument, type Command } from 'commander';
import { CONFIG_KEYS } from '../../config/config.js';
import { action, type Kit } from '../kit.js';

/** Maps "sub path" (e.g. "", "scene", "debug trace") to the words that can follow it. */
export function completionTree(program: Command): Record<string, string[]> {
  const tree: Record<string, string[]> = {};
  const walk = (cmd: Command, prefix: string): void => {
    const words = new Set<string>();
    for (const sub of cmd.commands) {
      if ((sub as unknown as { _hidden?: boolean })._hidden) continue;
      words.add(sub.name());
      for (const alias of sub.aliases()) words.add(alias);
      walk(sub, prefix ? `${prefix} ${sub.name()}` : sub.name());
      for (const alias of sub.aliases())
        tree[prefix ? `${prefix} ${alias}` : alias] =
          tree[prefix ? `${prefix} ${sub.name()}` : sub.name()] ?? [];
    }
    for (const opt of cmd.options) {
      if (opt.hidden) continue;
      if (opt.long) words.add(opt.long);
    }
    if (prefix === '') for (const opt of cmd.options) if (opt.long) words.add(opt.long);
    tree[prefix] = [...words];
  };
  walk(program, '');
  tree['config get'] = [...(tree['config get'] ?? []), ...Object.keys(CONFIG_KEYS)];
  tree['config set'] = [...(tree['config set'] ?? []), ...Object.keys(CONFIG_KEYS)];
  tree['config unset'] = [...(tree['config unset'] ?? []), ...Object.keys(CONFIG_KEYS)];
  return tree;
}

function bashScript(tree: Record<string, string[]>): string {
  const cases = Object.entries(tree)
    .map(([k, v]) => `    "${k}") words="${v.join(' ')}" ;;`)
    .join('\n');
  return `# gvids bash completion. Install: gvids completion bash >> ~/.bashrc
_gvids_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local path="" candidate w i
  for ((i = 1; i < COMP_CWORD; i++)); do
    w="\${COMP_WORDS[i]}"
    [[ "$w" == -* ]] && continue
    if [[ -z "$path" ]]; then candidate="$w"; else candidate="$path $w"; fi
    if _gvids_has "$candidate"; then path="$candidate"; fi
  done
  local words=""
  case "$path" in
${cases}
  esac
  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}
_gvids_has() {
  case "$1" in
${Object.keys(tree)
  .filter(Boolean)
  .map((k) => `    "${k}") return 0 ;;`)
  .join('\n')}
  esac
  return 1
}
complete -o default -F _gvids_complete gvids
`;
}

function zshScript(tree: Record<string, string[]>): string {
  return `# gvids zsh completion. Install: gvids completion zsh > "\${fpath[1]}/_gvids" or add to ~/.zshrc:
#   source <(gvids completion zsh)
autoload -U +X bashcompinit && bashcompinit
${bashScript(tree)}`;
}

function fishScript(tree: Record<string, string[]>): string {
  const lines = [
    '# gvids fish completion. Install: gvids completion fish > ~/.config/fish/completions/gvids.fish',
    'complete -c gvids -f',
  ];
  for (const [k, words] of Object.entries(tree)) {
    const subs = words.filter((w) => !w.startsWith('-'));
    const opts = words.filter((w) => w.startsWith('--'));
    const parts = k.split(' ').filter(Boolean);
    let condition: string;
    if (parts.length === 0) condition = '__fish_use_subcommand';
    else condition = `__fish_seen_subcommand_from ${parts[parts.length - 1]}`;
    if (subs.length) lines.push(`complete -c gvids -n '${condition}' -a '${subs.join(' ')}'`);
    for (const o of opts) lines.push(`complete -c gvids -n '${condition}' -l '${o.slice(2)}'`);
  }
  return `${lines.join('\n')}\n`;
}

function powershellScript(tree: Record<string, string[]>): string {
  const entries = Object.entries(tree)
    .map(([k, v]) => `    '${k}' = @(${v.map((w) => `'${w.replace(/'/g, "''")}'`).join(', ')})`)
    .join('\n');
  return `# gvids PowerShell completion. Install (current user):
#   gvids completion powershell | Out-String | Add-Content -Path $PROFILE
# or for this session only:
#   gvids completion powershell | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName gvids -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $tree = @{
${entries}
  }
  $elements = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() })
  if ($wordToComplete -and $elements.Count -gt 0 -and $elements[-1] -eq $wordToComplete) {
    $elements = @($elements | Select-Object -First ($elements.Count - 1))
  }
  $path = ''
  foreach ($w in $elements) {
    if ($w -like '-*') { continue }
    $candidate = if ($path) { "$path $w" } else { $w }
    if ($tree.ContainsKey($candidate)) { $path = $candidate }
  }
  $tree[$path] | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
  }
}
`;
}

export function registerCompletionCommand(program: Command, kit: Kit): void {
  program
    .command('completion')
    .description('Print a shell completion script (bash, zsh, fish, powershell)')
    .addArgument(new Argument('<shell>', 'target shell').choices(['bash', 'zsh', 'fish', 'powershell']))
    .addHelpText(
      'after',
      [
        '',
        'Install:',
        '  bash:        gvids completion bash >> ~/.bashrc',
        "  zsh:         echo 'source <(gvids completion zsh)' >> ~/.zshrc",
        '  fish:        gvids completion fish > ~/.config/fish/completions/gvids.fish',
        '  PowerShell:  gvids completion powershell | Out-String | Add-Content $PROFILE',
      ].join('\n'),
    )
    .action(
      action(kit, async (ctx, shell: 'bash' | 'zsh' | 'fish' | 'powershell') => {
        const tree = completionTree(program);
        const script =
          shell === 'bash'
            ? bashScript(tree)
            : shell === 'zsh'
              ? zshScript(tree)
              : shell === 'fish'
                ? fishScript(tree)
                : powershellScript(tree);
        // A shell script, not data: printed raw unless --json is given explicitly.
        if (ctx.globals.json) ctx.out.result({ shell, script });
        else ctx.io.stdout.write(script);
      }),
    );
}
