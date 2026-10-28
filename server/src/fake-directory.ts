// A fake UFS People directory feed with SYNTHETIC people only (never real employee data).
// Used by the tests and as a dev tool:  node src/fake-directory.ts [port]   (default 4310, token below)
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';

export const FAKE_TOKEN = 'fake-directory-token-for-local-dev-only';

export interface FakeEmployee { id: string; email: string; name: string; managerId: string | null; role: string; active: boolean; department: string; location: string; title: string; }
export interface FakeIdentity { subject: string; employeeId: string; enabled: boolean; notBefore?: string | null; }
export interface FakeFeed { version: number; generatedAt: string; employees: FakeEmployee[]; identities: FakeIdentity[]; [key: string]: unknown; }

const uuidFrom = (seed: string) => { const h = crypto.createHash('md5').update(seed).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const FIRST = ['Asha', 'Bruno', 'Chen', 'Dara', 'Elif', 'Farid', 'Gita', 'Hugo', 'Ines', 'Jonas', 'Kavya', 'Liam', 'Mei', 'Nadia', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sven', 'Tara', 'Uma', 'Viktor', 'Wen', 'Xena', 'Yusuf', 'Zoe'];
const LAST = ['Aldana', 'Brandt', 'Cole', 'Duarte', 'Erikson', 'Fofana', 'Garza', 'Hale', 'Iyer', 'Jovanovic', 'Khan', 'Lindqvist', 'Moreau', 'Nowak', 'Okafor', 'Petrov'];

/**
 * A small organisation: 1 admin (the tracker owner candidate), 2 HR managers, 4 managers, 1 hiring manager and
 * employees. Everything is derived from the index so the data is stable between runs.
 */
export function syntheticFeed(count = 30, now = Date.now()): FakeFeed {
  const departments = ['Engineering', 'Operations', 'People', 'Finance'];
  const employees: FakeEmployee[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `emp-${String(i).padStart(3, '0')}`, first = FIRST[i % FIRST.length]!, last = LAST[(i * 7) % LAST.length]!;
    const department = i === 1 ? 'Executive' : departments[i % departments.length]!;
    const role = i === 1 ? 'admin' : i <= 3 ? 'hr_manager' : i <= 7 ? 'manager' : i === 8 ? 'hiring_manager' : 'employee';
    const managerId = i === 1 ? null : i <= 7 ? 'emp-001' : `emp-${String(4 + (i % 4)).padStart(3, '0')}`;
    employees.push({ id, email: `${first}.${last}.${i}@example.test`.toLowerCase(), name: `${first} ${last}`, managerId, role, active: true, department, location: i % 2 ? 'Remote' : 'Head office', title: role === 'employee' ? 'Associate' : role.replace('_', ' ') });
  }
  const identities = employees.filter((_, i) => i % 5 !== 4).map(e => ({ subject: uuidFrom(`subject-${e.id}`), employeeId: e.id, enabled: true }));
  return { version: 1, generatedAt: new Date(now).toISOString(), employees, identities };
}

export interface FakeDirectory {
  url: string; port: number; feed: FakeFeed;
  /** Next requests fail with this HTTP status (or hang, or return junk) until cleared. */
  behavior: { status?: number; body?: string; delayMs?: number };
  requests: { url: string; authorization: string | undefined }[];
  touch(now?: number): void;                          // refresh generatedAt
  find(id: string): FakeEmployee;
  close(): Promise<void>;
}

export async function startFakeDirectory(opts: { port?: number; count?: number; now?: () => number; token?: string; dev?: boolean } = {}): Promise<FakeDirectory> {
  const token = opts.token ?? FAKE_TOKEN; const clock = opts.now ?? (() => Date.now());
  const state: FakeDirectory = {
    url: '', port: 0, feed: syntheticFeed(opts.count ?? 30, clock()), behavior: {}, requests: [],
    touch(now = clock()) { state.feed.generatedAt = new Date(now).toISOString(); },
    find(id) { const e = state.feed.employees.find(x => x.id === id); if (!e) throw new Error(`no fake employee ${id}`); return e; },
    close: () => new Promise<void>(r => server.close(() => r())),
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c)).on('end', async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      state.requests.push({ url: req.url ?? '', authorization: req.headers.authorization });
      if (opts.dev && req.method === 'POST' && path === '/__mutate') { // dev tool: simulate changes in UFS People
        try { const b = JSON.parse(Buffer.concat(chunks).toString() || '{}'); applyMutation(state, b); state.touch(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); }
        catch (e) { res.writeHead(400); res.end(String((e as Error).message)); }
        return;
      }
      if (path !== '/directory.json') { res.writeHead(404); return void res.end(); }
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'Content-Type': 'application/json' }); return void res.end('{"error":"Unauthorized"}'); }
      if (state.behavior.delayMs) await new Promise(r => setTimeout(r, state.behavior.delayMs));
      if (state.behavior.status && state.behavior.status !== 200) { res.writeHead(state.behavior.status); return void res.end(state.behavior.body ?? ''); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(state.behavior.body ?? JSON.stringify(state.feed));
    });
  });
  await new Promise<void>(r => server.listen(opts.port ?? 0, '127.0.0.1', () => r()));
  state.port = (server.address() as AddressInfo).port; state.url = `http://127.0.0.1:${state.port}/directory.json`;
  return state;
}

function applyMutation(state: FakeDirectory, b: any) {
  const feed = state.feed;
  switch (b.op) {
    case 'reset': Object.assign(feed, syntheticFeed(feed.employees.length)); break;
    case 'leave': state.find(b.id).active = false; break;
    case 'return': state.find(b.id).active = true; break;
    case 'remove': feed.employees = feed.employees.filter(e => e.id !== b.id); feed.identities = feed.identities.filter(i => i.employeeId !== b.id); break;
    case 'rename': state.find(b.id).name = String(b.name); break;
    case 'promote': state.find(b.id).role = String(b.role ?? 'manager'); break;
    case 'move': state.find(b.id).managerId = b.managerId ?? null; break;
    case 'department': state.find(b.id).department = String(b.department); break;
    case 'hire': { const n = feed.employees.length + 1, id = `emp-${String(n).padStart(3, '0')}`; feed.employees.push({ id, email: `new.hire.${n}@example.test`, name: String(b.name ?? `New Hire ${n}`), managerId: b.managerId ?? 'emp-004', role: 'employee', active: true, department: String(b.department ?? 'Engineering'), location: 'Remote', title: 'Associate' }); break; }
    case 'behavior': state.behavior = b.behavior ?? {}; break;
    default: throw new Error(`unknown op ${String(b.op)}`);
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const port = Number(process.argv[2] ?? 4310);
  const dir = await startFakeDirectory({ port, dev: true });
  console.log(`Fake UFS People directory (synthetic people) at ${dir.url}  token: ${FAKE_TOKEN}`);
  console.log('Dev mutations: POST /__mutate {"op":"leave|return|remove|rename|promote|move|department|hire|reset|behavior", ...}');
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => dir.close().then(() => process.exit(0)));
}
