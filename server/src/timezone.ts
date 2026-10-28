/** Small IANA timezone helpers for policy schedules and attendance evidence. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); return true; }
  catch { return false; }
}

export function parseDateOnly(value: unknown): string | null {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

export function addDateDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekday(date: string): number { return new Date(`${date}T00:00:00.000Z`).getUTCDay(); }

function parts(ms: number, timeZone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second) };
}

function sameLocal(p: ReturnType<typeof parts>, target: { year:number; month:number; day:number; hour:number; minute:number }) {
  return p.year === target.year && p.month === target.month && p.day === target.day && p.hour === target.hour && p.minute === target.minute && p.second === 0;
}

/** Convert a wall-clock schedule time to an instant. For a repeated DST minute, use the earlier instant. For a skipped minute, advance to its first valid minute. */
export function localDateTimeToMs(date: string, time: string, timeZone: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const base = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  for (let bump = 0; bump <= 180; bump++) {
    const wall = new Date(base + bump * 60_000);
    const target = { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate(), hour: wall.getUTCHours(), minute: wall.getUTCMinutes() };
    const naive = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
    const offsets = new Set<number>();
    for (const delta of [-172_800_000, -86_400_000, 0, 86_400_000, 172_800_000]) {
      const instant = naive + delta, p = parts(instant, timeZone);
      offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant);
    }
    const matches: number[] = [];
    for (const offset of offsets) {
      const candidate = naive - offset;
      if (sameLocal(parts(candidate, timeZone), target)) matches.push(candidate);
    }
    if (matches.length) return Math.min(...matches);
  }
  throw new RangeError(`Could not resolve local time in ${timeZone}.`);
}

export function localDateTime(ms: number, timeZone: string) {
  const p = parts(ms, timeZone);
  return { date: `${String(p.year).padStart(4,'0')}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`, weekday: new Date(Date.UTC(p.year,p.month-1,p.day)).getUTCDay(), minute: p.hour * 60 + p.minute };
}
