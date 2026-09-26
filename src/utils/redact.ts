/**
 * Secret redaction. Everything that leaves the process through logs, debug
 * files or error output passes through here. Patterns are deliberately broad:
 * a false positive costs a little readability, a false negative leaks a token.
 */

const REDACTED = '[REDACTED]';

const SECRET_KEY_PATTERN =
  /^(access_?token|refresh_?token|id_?token|token|client_?secret|authorization|cookie|cookies|set-cookie|password|passwd|secret|api_?key|x-goog-api-key|code_?verifier|auth_?code|sid|hsid|ssid|apisid|sapisid)$/i;

const VALUE_PATTERNS: Array<[RegExp, string]> = [
  // Google OAuth access tokens and refresh tokens.
  [/ya29\.[0-9A-Za-z_\-.]+/g, `ya29.${REDACTED}`],
  [/\b1\/\/[0-9A-Za-z_-]{20,}/g, `1//${REDACTED}`],
  // Authorization headers.
  [/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // OAuth client secrets (GOCSPX- prefix).
  [/GOCSPX-[0-9A-Za-z_-]+/g, `GOCSPX-${REDACTED}`],
  // Google API keys.
  [/AIza[0-9A-Za-z_-]{30,}/g, `AIza${REDACTED}`],
  // Authorization codes in redirect URLs and query strings.
  [/([?&](?:code|access_token|refresh_token|id_token|token|key)=)[^&#\s]+/gi, `$1${REDACTED}`],
  // Google session cookies.
  [
    /\b((?:__Secure-|__Host-)?(?:[0-9]P)?(?:SID|HSID|SSID|APISID|SAPISID|SIDCC|NID|OSID|LSID)(?:TS)?)=[^;\s]+/g,
    `$1=${REDACTED}`,
  ],
  // JWT-shaped strings (id_tokens).
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED],
];

export function redactString(input: string): string {
  let out = input;
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Additionally hides e-mail addresses. Used for diagnostics files that users may attach to bug reports. */
export function redactPersonal(input: string): string {
  return redactString(input).replace(EMAIL_PATTERN, '<email>');
}

/**
 * For saved page HTML: inline <script> bodies carry session-bound values (for
 * example the editor's request token), so they are dropped; the DOM is kept.
 */
export function redactHtml(html: string): string {
  const stripped = html.replace(
    /(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi,
    (_m, open: string, close: string) => `${open}/* removed by gvids */${close}`,
  );
  return redactPersonal(stripped);
}

export function redactValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]' as T;
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, seen)) as T;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) } as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key) && v !== undefined && v !== null && v !== '') {
      out[key] = REDACTED;
    } else {
      out[key] = redactValue(v, seen);
    }
  }
  return out as T;
}

/** Command-line flags whose value is a secret. */
const SECRET_FLAGS = new Set(['--client-secret']);

/**
 * Masks secret flag values in an argument list before it is echoed back
 * (dry-run plans, task records, batch results, retry suggestions).
 */
export function redactArgv(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const eq = arg.indexOf('=');
    if (eq > 0 && SECRET_FLAGS.has(arg.slice(0, eq))) {
      out.push(`${arg.slice(0, eq)}=${REDACTED}`);
    } else if (SECRET_FLAGS.has(arg) && i + 1 < args.length) {
      out.push(arg, REDACTED);
      i++;
    } else {
      out.push(redactString(arg));
    }
  }
  return out;
}

/** Masks all but the first/last few characters (for showing client IDs). */
export function mask(value: string | undefined, visible = 6): string {
  if (!value) return '';
  if (value.length <= visible * 2) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, visible)}…${value.slice(-4)}`;
}
