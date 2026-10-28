// Local demo data: synthetic people, projects, time and placeholder images. NEVER use real employee data here.
// Run with an empty data dir:  TRACKER_DATA_DIR=./data-demo node src/seed-demo.ts
import crypto from 'node:crypto';
import { loadConfig } from './config.ts';
import { openDb, nowIso } from './db.ts';
import { DiskStore } from './storage.ts';
import { hashPassword } from './auth.ts';
import { syntheticPng } from './synthetic-png.ts';

// Dev-only password for the synthetic demo accounts; printed nowhere, change it before any real use.
export const DEMO_PASSWORD = 'Demo-password-2026';

const cfg = loadConfig();
const db = openDb(cfg.dbFile);
if ((db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c > 0) { console.error('The database already has users; refusing to seed. Use an empty TRACKER_DATA_DIR.'); process.exit(1); }
const store = new DiskStore(cfg.screenshotsDir);
const now = Date.now(), iso = (ms: number) => nowIso(ms);
const id = () => crypto.randomUUID();
const hash = hashPassword(DEMO_PASSWORD);

const teams = { eng: id(), ops: id() };
db.prepare('INSERT INTO teams (id,name,created_at) VALUES (?,?,?)').run(teams.eng, 'Engineering', iso(now));
db.prepare('INSERT INTO teams (id,name,created_at) VALUES (?,?,?)').run(teams.ops, 'Operations', iso(now));

const people: Record<string, { id: string; email: string }> = {};
const addUser = (key: string, name: string, role: string, manager: string | null, team: string | null) => {
  const userId = id();
  db.prepare('INSERT INTO users (id,email,name,role,manager_id,team_id,password_hash,consent_version,consent_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(userId, `${key}@demo.example`, name, role, manager ? people[manager]!.id : null, team, hash, 1, iso(now), iso(now));
  people[key] = { id: userId, email: `${key}@demo.example` };
};
addUser('owner', 'Olivia Owner', 'owner', null, null);
addUser('admin', 'Adam Admin', 'admin', null, null);
addUser('hana', 'Hana HR', 'hr', null, null);
addUser('maria', 'Maria Manager', 'manager', null, teams.eng);
addUser('omar', 'Omar Manager', 'manager', null, teams.ops);
addUser('ana', 'Ana Engineer', 'employee', 'maria', teams.eng);
addUser('ben', 'Ben Engineer', 'employee', 'maria', teams.eng);
addUser('cara', 'Cara Support', 'employee', 'omar', teams.ops);
addUser('dev', 'Dev Support', 'employee', 'omar', teams.ops);

const projects = [['Website redesign', 'Acme', teams.eng, ['Design', 'Build', 'QA']], ['Mobile app', 'Globex', teams.eng, ['API', 'UI']], ['Customer support', null, teams.ops, ['Tickets', 'Docs']], ['Internal admin', null, null, ['Meetings']]] as const;
const projectIds: string[] = [];
for (const [name, client, team, tasks] of projects) {
  const pid = id(); projectIds.push(pid);
  db.prepare('INSERT INTO projects (id,name,client,team_id,created_at) VALUES (?,?,?,?,?)').run(pid, name, client, team, iso(now));
  for (const t of tasks) db.prepare('INSERT INTO tasks (id,project_id,name,created_at) VALUES (?,?,?,?)').run(id(), pid, t, iso(now));
}

// Time and screenshots for the last 5 working days.
const employees: [string, number[]][] = [['ana', [0, 1]], ['ben', [0, 1, 3]], ['cara', [2, 3]], ['dev', [2, 3]]];
const colours: [number, number, number][] = [[40, 90, 160], [160, 70, 60], [50, 140, 90], [120, 90, 160]];
let shots = 0;
for (const [key, projectPool] of employees) {
  const user = people[key]!;
  for (let d = 1; d <= 5; d++) {
    const dayStart = new Date(now - d * 86400_000); dayStart.setUTCHours(9, 0, 0, 0);
    for (let block = 0; block < 2; block++) {
      const start = dayStart.getTime() + block * 4 * 3600_000, tracked = (3 + ((d + block) % 2) * 0.5) * 3600_000;
      const pid = projectIds[projectPool[(d + block) % projectPool.length]!]!;
      const entryId = id();
      db.prepare(`INSERT INTO time_entries (id,user_id,client_id,project_id,task_label,source,mode,start_at,end_at,tracked_ms,idle_ms,status,created_at,updated_at) VALUES (?,?,?,?,?,'tracker','manual',?,?,?,?,?,?,?)`)
        .run(entryId, user.id, `demo-${entryId}`, pid, 'Demo work', iso(start), iso(start + tracked), tracked, Math.round(tracked * 0.08), d > 2 ? 'approved' : 'pending', iso(start), iso(start + tracked));
      for (let s = 0; s * 20 * 60_000 < tracked; s++) {
        const shotId = id(), bytes = syntheticPng(320, 180, colours[(s + d) % colours.length]!), thumb = syntheticPng(96, 54, colours[(s + d) % colours.length]!);
        await store.put(user.id, `${shotId}.png`, bytes); await store.put(user.id, `${shotId}.thumb.png`, thumb);
        db.prepare('INSERT INTO screenshots (id,user_id,client_id,entry_client_id,taken_at,width,height,bytes,sha256,file_name,thumb_file_name,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(shotId, user.id, `demo-shot-${shotId}`, `demo-${entryId}`, iso(start + s * 20 * 60_000), 320, 180, bytes.length, crypto.createHash('sha256').update(bytes).digest('hex'), `${shotId}.png`, `${shotId}.thumb.png`, iso(start));
        shots++;
      }
    }
  }
}
console.log(`Seeded demo org: 9 users, 2 teams, ${projects.length} projects, ${shots} placeholder screenshots.`);
console.log('Sign in as owner@, admin@, hana@ (HR), maria@ (manager) or ana@ (employee) + demo.example (all synthetic).');
console.log('The demo password is the DEMO_PASSWORD constant in server/src/seed-demo.ts.');
