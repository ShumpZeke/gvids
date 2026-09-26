#!/usr/bin/env node
import { CancelledError, GvidsError } from '../errors/errors.js';
import { ExitCode } from '../errors/exit-codes.js';
import { onShutdownFinal, shutdown, type ShutdownReason } from '../utils/shutdown.js';
import { runCli } from './program.js';
import { formatFromArgs, processIO } from './context.js';
import { hasWrittenResult, writtenResultOk } from './output/output.js';

const io = processIO();
const json = formatFromArgs(process.argv.slice(2), io.env) !== 'text';
// `gvids mcp` owns stdout for the MCP protocol: nothing else may be written there.
const mcpServer = process.argv.slice(2).find((a) => !a.startsWith('-')) === 'mcp';

/** The last line an agent sees when the command could not finish normally. */
function report(error: GvidsError): void {
  if (hasWrittenResult(process.stdout) || mcpServer) return;
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: false, data: null, error: error.toJSON() })}\n`);
  } else {
    process.stderr.write(`Error: ${error.message}\n`);
  }
}

// A --detach worker records its own outcome (see WorkerTask in program.ts).
if (!io.env.GVIDS_TASK_ID) {
  onShutdownFinal(async (reason) =>
    report(new CancelledError(`Cancelled (${reason === 'cancel' ? 'task cancelled' : reason}).`)),
  );
}

// Ctrl+C / SIGTERM: close browser tabs and sessions, report CANCELLED, exit 130.
// A second signal exits at once.
let signals = 0;
const onSignal = (reason: ShutdownReason): void => {
  signals++;
  if (signals > 1) process.exit(ExitCode.Cancelled);
  // A command that already reported success keeps exit 0; everything else is CANCELLED (130).
  void shutdown(reason).then(() =>
    process.exit(writtenResultOk(process.stdout) === true ? ExitCode.Success : ExitCode.Cancelled),
  );
};
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

runCli(process.argv, io)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    report(
      new GvidsError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`, {
        code: 'GENERIC_ERROR',
      }),
    );
    process.exitCode = ExitCode.GenericError;
  });
