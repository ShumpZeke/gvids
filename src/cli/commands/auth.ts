import { Option, type Command } from 'commander';
import { importClientSecretFile } from '../../auth/client-credentials.js';
import { AuthError, GvidsError, type ErrorCode } from '../../errors/errors.js';
import { ExitCode } from '../../errors/exit-codes.js';

const AUTH_CODES = new Set<ErrorCode>([
  'AUTH_REQUIRED',
  'OAUTH_CLIENT_MISSING',
  'TOKEN_EXPIRED',
  'INSUFFICIENT_SCOPES',
]);
import type { AuthStatus } from '../../auth/oauth.js';
import { SCOPE_PROFILES, type ScopeProfile } from '../../auth/scopes.js';
import { parsePositiveInt } from '../../utils/input.js';
import type { CommandContext } from '../context.js';
import { action, type Kit } from '../kit.js';

interface LoginFlags {
  scopes?: ScopeProfile;
  clientSecretFile?: string;
  clientId?: string;
  clientSecret?: string;
  browser: boolean;
  port?: string;
  loginHint?: string;
}

export function renderAuthStatus(s: AuthStatus): string {
  const lines: string[] = [];
  if (s.authenticated) {
    const who = s.account?.email
      ? `${s.account.email}${s.account.name ? ` (${s.account.name})` : ''}`
      : 'unknown account';
    lines.push(`Signed in to the Google Drive API as ${who}`);
  } else {
    lines.push('Not signed in to the Google Drive API.');
    if (s.problem) lines.push(`  ${s.problem}`);
  }
  lines.push(`  method:       ${s.method}`);
  if (s.scopes?.length) lines.push(`  scopes:       ${s.scopes.join(' ')}`);
  if (s.tokenStore) lines.push(`  token store:  ${s.tokenStore.location}`);
  if (s.client) lines.push(`  oauth client: ${s.client.clientId} (from ${s.client.source})`);
  if (s.accessTokenExpiresAt) lines.push(`  access token: valid until ${s.accessTokenExpiresAt}`);
  if (!s.authenticated) lines.push('', 'Run: gvids auth login');
  return lines.join('\n');
}

async function login(ctx: CommandContext, flags: LoginFlags): Promise<void> {
  if (flags.clientSecretFile) {
    const saved = await importClientSecretFile(flags.clientSecretFile, ctx.io.env);
    ctx.out.info(`Saved OAuth client to ${saved}`);
  }
  const status = await (
    await ctx.auth()
  ).login({
    ...(flags.scopes ? { scopes: flags.scopes } : {}),
    ...(flags.clientId ? { clientId: flags.clientId } : {}),
    ...(flags.clientSecret ? { clientSecret: flags.clientSecret } : {}),
    ...(flags.port ? { port: parsePositiveInt(flags.port, '--port') } : {}),
    ...(flags.loginHint ? { loginHint: flags.loginHint } : {}),
    timeoutMs: ctx.timeoutMs(5 * 60_000),
    onUrl: (url) => {
      // The consent URL contains no secrets (PKCE challenge + state only), but it is long;
      // always print it so users on headless machines can copy it.
      ctx.io.stderr.write(
        `${flags.browser ? 'Opening your browser to sign in to Google.\nIf it does not open, visit:' : 'Open this URL in a browser to sign in:'}\n\n  ${url}\n\nWaiting for Google sign-in…\n`,
      );
    },
    ...(flags.browser ? { openBrowser: (url: string) => ctx.openUrl(url) } : {}),
  });
  ctx.out.result(status, renderAuthStatus);
}

function addLoginFlags(cmd: Command): Command {
  return cmd
    .addOption(new Option('--scopes <profile>', 'scope profile to request').choices(['full', 'readonly']))
    .option('--client-secret-file <file>', 'OAuth "Desktop app" client JSON (copied to ~/.gvids)')
    .option('--client-id <id>', 'OAuth client ID (alternative to a JSON file)')
    .option('--client-secret <secret>', 'OAuth client secret')
    .option('--no-browser', 'print the sign-in URL instead of opening a browser')
    .option('--port <port>', 'fixed loopback port for the OAuth redirect (default: random)')
    .option('--login-hint <email>', 'pre-select this Google account');
}

export function registerAuthCommands(program: Command, kit: Kit): void {
  const auth = program.command('auth').description('Google OAuth sign-in for the Drive API');

  addLoginFlags(
    auth
      .command('login')
      .description('Sign in with Google (OAuth loopback + PKCE) and store tokens securely'),
  ).action(action(kit, async (ctx, flags: LoginFlags) => login(ctx, flags)));

  auth
    .command('logout')
    .description('Revoke and delete stored OAuth tokens (a person must sign in again afterwards)')
    .option('--no-revoke', 'only delete local tokens; do not revoke them at Google')
    .action(
      action(kit, async (ctx, flags: { revoke: boolean }) => {
        await ctx.confirm(
          'Sign gvids out of the Google Drive API?',
          'sign out of the Drive API (only a person can sign in again)',
        );
        const result = await (await ctx.auth()).logout({ revoke: flags.revoke });
        ctx.out.result(result, (r) =>
          r.cleared.length === 0
            ? 'No stored credentials found.'
            : `Signed out${r.revoked ? ' and revoked the token at Google' : ''} (cleared: ${r.cleared.join(', ')}).`,
        );
      }),
    );

  auth
    .command('status')
    .description(
      'Show which Google account the Drive API uses (fails with AUTH_REQUIRED and the status as data when not signed in)',
    )
    .option('--no-verify', 'do not contact Google to verify the token')
    .action(
      action(kit, async (ctx, flags: { verify: boolean }) => {
        const status = await (await ctx.auth()).status({ verify: flags.verify });
        if (!status.authenticated) {
          // The status is still useful: it is returned as the error envelope's data.
          ctx.partialData = status;
          const code = (status.problemCode ?? 'AUTH_REQUIRED') as ErrorCode;
          const message = status.problem ?? 'Not signed in to the Google Drive API.';
          if (!AUTH_CODES.has(code)) {
            // Could not verify (network or Google outage) rather than "not signed in".
            throw new GvidsError(message, {
              code,
              exitCode: ExitCode.GoogleApiFailure,
              ...(code === 'GOOGLE_API_ERROR' ? { retryable: true } : {}),
              ...(status.problemHint ? { hint: status.problemHint } : {}),
            });
          }
          throw new AuthError(message, { code, hint: status.problemHint ?? ['Run: gvids auth login'] });
        }
        ctx.out.result(status, renderAuthStatus);
      }),
    );

  auth
    .command('scopes')
    .description('Explain the OAuth scopes gvids requests')
    .action(
      action(kit, async (ctx) => {
        const profiles = Object.entries(SCOPE_PROFILES).map(([name, scopes]) => ({
          profile: name,
          default: name === ctx.config.auth.scopes,
          scopes,
        }));
        ctx.out.result({ profiles }, (d) =>
          [
            'gvids uses the Google Drive API only; Google Vids has no public editing API.',
            '',
            ...d.profiles.flatMap((p) => [
              `${p.profile}${p.default ? ' (default)' : ''}`,
              ...p.scopes.map(
                (s) => `  ${s.scope}\n    ${s.purpose}\n    Google classification: ${s.sensitivity}`,
              ),
              '',
            ]),
            'Editor automation (storyboard, scenes, AI) uses your normal Google sign-in in the',
            'gvids browser profile and needs no OAuth scope. See: gvids browser login',
          ].join('\n'),
        );
      }),
    );

  // Convenience alias used in the README quick start.
  addLoginFlags(program.command('login').description('Alias for `gvids auth login`')).action(
    action(kit, async (ctx, flags: LoginFlags) => login(ctx, flags)),
  );
}
