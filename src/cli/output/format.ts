export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso: string | undefined | null): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function truncate(text: string, max: number): string {
  if (max <= 1) return text.slice(0, max);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

export function visibleLength(text: string): number {
  return [...text.replace(ANSI_PATTERN, '')].length;
}

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  maxWidth?: number;
  align?: 'left' | 'right';
}

/** Renders a simple aligned text table (no box drawing, copy/paste friendly). */
export function renderTable<T>(rows: T[], columns: Column<T>[]): string {
  const cells = rows.map((row) =>
    columns.map((c) => {
      const raw = c.value(row).replace(/\s+/g, ' ');
      return c.maxWidth ? truncate(raw, c.maxWidth) : raw;
    }),
  );
  const widths = columns.map((c, i) =>
    Math.max(visibleLength(c.header), ...cells.map((r) => visibleLength(r[i] ?? ''))),
  );
  const pad = (text: string, width: number, align: 'left' | 'right' = 'left'): string => {
    const gap = ' '.repeat(Math.max(0, width - visibleLength(text)));
    return align === 'right' ? gap + text : text + gap;
  };
  const header = columns.map((c, i) => pad(c.header, widths[i]!, c.align)).join('  ');
  const body = cells.map((r) => r.map((cell, i) => pad(cell, widths[i]!, columns[i]!.align)).join('  '));
  return [header.trimEnd(), ...body.map((l) => l.trimEnd())].join('\n');
}
