import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type Db = DatabaseSync;
export type Row = Record<string, any>;

// Schema is plain SQL kept portable to Postgres (TEXT ids, ISO-8601 UTC timestamps, JSON in TEXT).
const MIGRATIONS: string[] = [
  `
  CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','manager','employee')),
    manager_id TEXT REFERENCES users(id),
    team_id TEXT REFERENCES teams(id),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    consent_version INTEGER,
    consent_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK (kind IN ('web','device')),
    device_name TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, client TEXT, team_id TEXT REFERENCES teams(id),
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE time_entries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    client_id TEXT NOT NULL,
    project_id TEXT REFERENCES projects(id),
    task_id TEXT REFERENCES tasks(id),
    task_label TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('tracker','manual')),
    mode TEXT,
    start_at TEXT NOT NULL,
    end_at TEXT,
    tracked_ms INTEGER NOT NULL DEFAULT 0,
    idle_ms INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    note TEXT,
    edited INTEGER NOT NULL DEFAULT 0,
    reviewed_by TEXT REFERENCES users(id),
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, client_id)
  );
  CREATE INDEX time_entries_user_start ON time_entries(user_id, start_at);
  CREATE TABLE screenshots (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    client_id TEXT NOT NULL,
    entry_client_id TEXT,
    taken_at TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    file_name TEXT NOT NULL,
    thumb_file_name TEXT,
    deleted_at TEXT,
    deleted_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, client_id)
  );
  CREATE INDEX screenshots_user_taken ON screenshots(user_id, taken_at);
  CREATE TABLE presence (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    status TEXT NOT NULL,
    project_id TEXT,
    task_label TEXT,
    tracked_ms INTEGER NOT NULL DEFAULT 0,
    device_name TEXT,
    last_seen_at TEXT NOT NULL
  );
  CREATE TABLE policy (
    scope TEXT NOT NULL CHECK (scope IN ('org','team','user')),
    scope_id TEXT NOT NULL,
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, scope_id)
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    detail TEXT
  );
  CREATE INDEX audit_at ON audit_log(at);
  `,
  // 2: add the 'hr' role. SQLite cannot alter a CHECK constraint, so the users table is rebuilt (foreign keys are
  // switched off around this migration by applyMigrations and verified afterwards).
  `
  CREATE TABLE users_new (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','hr','manager','employee')),
    manager_id TEXT REFERENCES users(id),
    team_id TEXT REFERENCES teams(id),
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    consent_version INTEGER,
    consent_at TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO users_new (id,email,name,role,manager_id,team_id,password_hash,active,must_change_password,consent_version,consent_at,created_at)
    SELECT id,email,name,role,manager_id,team_id,password_hash,active,must_change_password,consent_version,consent_at,created_at FROM users;
  DROP TABLE users;
  ALTER TABLE users_new RENAME TO users;
  `,
  // 3: UFS People directory (Phase 2a). Users with source='directory' are projections of directory_employees: the
  // directory owns their name, email, role, manager, team and active flag; the tracker owns consent, sessions,
  // policy overrides and tracked data. Identities map a Supabase subject to an employee (never matched by email).
  `
  ALTER TABLE users ADD COLUMN directory_id TEXT;
  ALTER TABLE users ADD COLUMN source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local','directory'));
  CREATE UNIQUE INDEX users_directory_id ON users(directory_id) WHERE directory_id IS NOT NULL;
  CREATE TABLE directory_employees (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    manager_id TEXT,
    source_role TEXT NOT NULL,
    active INTEGER NOT NULL,
    department TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    first_seen_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    removed_at TEXT
  );
  CREATE TABLE directory_identities (
    subject TEXT PRIMARY KEY,
    employee_id TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX directory_identities_employee ON directory_identities(employee_id);
  CREATE TABLE directory_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok','blocked','failed')),
    feed_generated_at TEXT,
    added INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    deactivated INTEGER NOT NULL DEFAULT 0,
    reactivated INTEGER NOT NULL DEFAULT 0,
    unchanged INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    warnings TEXT
  );
  `,
  // 4: Supabase sign-in (Phase 2b). Tracker sessions remember how they were created (never any Supabase token) so a
  // disabled identity, a password-reset cutoff or a leaver can revoke exactly the right sessions.
  `
  ALTER TABLE sessions ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'local' CHECK (auth_source IN ('local','supabase'));
  ALTER TABLE sessions ADD COLUMN supabase_sub TEXT;
  ALTER TABLE sessions ADD COLUMN aal TEXT;
  CREATE INDEX sessions_supabase_sub ON sessions(supabase_sub) WHERE supabase_sub IS NOT NULL;
  ALTER TABLE directory_identities ADD COLUMN not_before TEXT;
  `,
  // 5: count-only keyboard/mouse activity at minute granularity. No raw event fields exist in this table.
  `
  ALTER TABLE time_entries ADD COLUMN activity_enabled INTEGER NOT NULL DEFAULT 0 CHECK (activity_enabled IN (0,1));
  ALTER TABLE time_entries ADD COLUMN activity_consent_version INTEGER;
  CREATE TABLE activity_slices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entry_client_id TEXT NOT NULL,
    slice_start_at TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 1 AND 60),
    keyboard_count INTEGER NOT NULL CHECK (keyboard_count BETWEEN 0 AND 10000),
    mouse_count INTEGER NOT NULL CHECK (mouse_count BETWEEN 0 AND 10000),
    active_seconds INTEGER NOT NULL CHECK (active_seconds BETWEEN 0 AND duration_seconds),
    created_at TEXT NOT NULL,
    UNIQUE (user_id, entry_client_id, slice_start_at),
    FOREIGN KEY (user_id, entry_client_id) REFERENCES time_entries(user_id, client_id) ON DELETE CASCADE
  );
  CREATE INDEX activity_slices_user_minute ON activity_slices(user_id, slice_start_at);
  `,
  // 6: additive daily UTC aggregates for activity reports. Minute slices remain the source of truth;
  // triggers keep the rollups idempotent with slice inserts/deletes, and the migration backfills old data.
  `
  CREATE TABLE activity_daily_rollups (
    user_id TEXT NOT NULL,
    entry_client_id TEXT NOT NULL,
    utc_date TEXT NOT NULL,
    slice_count INTEGER NOT NULL CHECK (slice_count > 0),
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds > 0),
    active_seconds INTEGER NOT NULL CHECK (active_seconds >= 0),
    keyboard_count INTEGER NOT NULL CHECK (keyboard_count >= 0),
    mouse_count INTEGER NOT NULL CHECK (mouse_count >= 0),
    PRIMARY KEY (user_id, entry_client_id, utc_date),
    FOREIGN KEY (user_id, entry_client_id) REFERENCES time_entries(user_id, client_id) ON DELETE CASCADE
  );
  INSERT INTO activity_daily_rollups (user_id,entry_client_id,utc_date,slice_count,duration_seconds,active_seconds,keyboard_count,mouse_count)
    SELECT user_id,entry_client_id,substr(slice_start_at,1,10),COUNT(*),SUM(duration_seconds),SUM(active_seconds),SUM(keyboard_count),SUM(mouse_count)
    FROM activity_slices GROUP BY user_id,entry_client_id,substr(slice_start_at,1,10);
  CREATE INDEX activity_daily_date ON activity_daily_rollups(utc_date,user_id);
  CREATE TRIGGER activity_rollup_insert AFTER INSERT ON activity_slices BEGIN
    INSERT INTO activity_daily_rollups (user_id,entry_client_id,utc_date,slice_count,duration_seconds,active_seconds,keyboard_count,mouse_count)
    VALUES (NEW.user_id,NEW.entry_client_id,substr(NEW.slice_start_at,1,10),1,NEW.duration_seconds,NEW.active_seconds,NEW.keyboard_count,NEW.mouse_count)
    ON CONFLICT(user_id,entry_client_id,utc_date) DO UPDATE SET
      slice_count=slice_count+1,duration_seconds=duration_seconds+NEW.duration_seconds,
      active_seconds=active_seconds+NEW.active_seconds,keyboard_count=keyboard_count+NEW.keyboard_count,mouse_count=mouse_count+NEW.mouse_count;
  END;
  CREATE TRIGGER activity_rollup_delete AFTER DELETE ON activity_slices BEGIN
    DELETE FROM activity_daily_rollups WHERE user_id=OLD.user_id AND entry_client_id=OLD.entry_client_id
      AND utc_date=substr(OLD.slice_start_at,1,10) AND slice_count<=1;
    UPDATE activity_daily_rollups SET slice_count=slice_count-1,duration_seconds=duration_seconds-OLD.duration_seconds,
      active_seconds=active_seconds-OLD.active_seconds,keyboard_count=keyboard_count-OLD.keyboard_count,mouse_count=mouse_count-OLD.mouse_count
      WHERE user_id=OLD.user_id AND entry_client_id=OLD.entry_client_id AND utc_date=substr(OLD.slice_start_at,1,10);
  END;
  CREATE TRIGGER activity_rollup_update AFTER UPDATE ON activity_slices BEGIN
    DELETE FROM activity_daily_rollups WHERE user_id=OLD.user_id AND entry_client_id=OLD.entry_client_id
      AND utc_date=substr(OLD.slice_start_at,1,10) AND slice_count<=1;
    UPDATE activity_daily_rollups SET slice_count=slice_count-1,duration_seconds=duration_seconds-OLD.duration_seconds,
      active_seconds=active_seconds-OLD.active_seconds,keyboard_count=keyboard_count-OLD.keyboard_count,mouse_count=mouse_count-OLD.mouse_count
      WHERE user_id=OLD.user_id AND entry_client_id=OLD.entry_client_id AND utc_date=substr(OLD.slice_start_at,1,10);
    INSERT INTO activity_daily_rollups (user_id,entry_client_id,utc_date,slice_count,duration_seconds,active_seconds,keyboard_count,mouse_count)
    VALUES (NEW.user_id,NEW.entry_client_id,substr(NEW.slice_start_at,1,10),1,NEW.duration_seconds,NEW.active_seconds,NEW.keyboard_count,NEW.mouse_count)
    ON CONFLICT(user_id,entry_client_id,utc_date) DO UPDATE SET
      slice_count=slice_count+1,duration_seconds=duration_seconds+NEW.duration_seconds,
      active_seconds=active_seconds+NEW.active_seconds,keyboard_count=keyboard_count+NEW.keyboard_count,mouse_count=mouse_count+NEW.mouse_count;
  END;
  `,
  // 7: in-app notifications with an email outbox, pay-rate history (payroll export) and data-deletion requests.
  `
  ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT,
    created_at TEXT NOT NULL, read_at TEXT
  );
  CREATE INDEX notifications_user ON notifications(user_id, read_at, id);
  CREATE TABLE email_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
    sent_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT
  );
  CREATE INDEX email_outbox_pending ON email_outbox(sent_at, attempts);
  CREATE TABLE pay_rates (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hourly_cents INTEGER NOT NULL CHECK (hourly_cents >= 0),
    currency TEXT NOT NULL, effective_from TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL
  );
  CREATE INDEX pay_rates_user ON pay_rates(user_id, effective_from);
  CREATE TABLE data_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('delete')), note TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','fulfilled','declined')),
    created_at TEXT NOT NULL, resolved_by TEXT, resolved_at TEXT, resolution_note TEXT
  );
  `,
  // 8: break records (pauses the employee chose as a break), synced with the company time entry.
  `  CREATE TABLE breaks (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, entry_client_id TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (user_id, entry_client_id, start_at),
    FOREIGN KEY (user_id, entry_client_id) REFERENCES time_entries(user_id, client_id) ON DELETE CASCADE
  );
  CREATE INDEX breaks_user_start ON breaks(user_id, start_at);
  `,
  // 9: weekly report subscriptions (delivered as in-app notifications and, when a mailer exists, email).
  `  CREATE TABLE report_subscriptions (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('team-hours','approvals','my-hours')),
    weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6), hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
    time_zone TEXT NOT NULL, created_at TEXT NOT NULL, last_period TEXT
  );
  CREATE UNIQUE INDEX report_subscriptions_unique ON report_subscriptions(user_id, kind);
  `,
  // 10: API keys for the read-only public API (only a hash of each key is stored).
  `  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, scopes TEXT NOT NULL,
    created_by TEXT, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
  );
  `,
  // 11: webhooks (signed event pushes) and their delivery queue.
  `  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, consecutive_failures INTEGER NOT NULL DEFAULT 0, disabled_reason TEXT,
    created_by TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE, event TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')), attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL, last_error TEXT, last_status INTEGER, created_at TEXT NOT NULL, delivered_at TEXT
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
  CREATE INDEX webhook_deliveries_hook ON webhook_deliveries(webhook_id, created_at);
  `,
];

/** Applies pending migrations (optionally only up to `upTo`, for tests). Throws if any foreign key is left dangling. */
export function applyMigrations(db: Db, upTo = MIGRATIONS.length) {
  const current = Number((db.prepare('PRAGMA user_version').get() as Row).user_version);
  db.exec('PRAGMA foreign_keys = OFF'); // must be set outside a transaction; table rebuilds need it
  try {
    for (let v = current; v < upTo; v++) {
      db.exec('BEGIN');
      try {
        db.exec(MIGRATIONS[v]!);
        const dangling = db.prepare('PRAGMA foreign_key_check').all();
        if (dangling.length) throw new Error(`Migration ${v + 1} left ${dangling.length} dangling foreign key(s).`);
        db.exec(`PRAGMA user_version = ${v + 1}`);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  } finally { db.exec('PRAGMA foreign_keys = ON'); }
}

export function openDb(file: string): Db {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  applyMigrations(db);
  return db;
}

export const nowIso = (ms: number) => new Date(ms).toISOString();
