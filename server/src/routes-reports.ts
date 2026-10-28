import { Router } from 'express';
import type { Ctx } from './ctx.ts';
import { send, isoDate } from './ctx.ts';
import type { Row } from './db.ts';
import { HttpError, audit, canSeeUser, currentUser, visibleUserIds } from './auth.ts';
import { addDateDays, localDateTimeToMs, parseDateOnly, weekday } from './timezone.ts';
import { effectivePolicy } from './policy.ts';

/** Neutralize spreadsheet formula injection and quote CSV cells. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
const hours = (ms: number) => Math.round(ms / 36000) / 100; // 2 decimals

export function reportRoutes(ctx: Ctx) {
  const r = Router();

  r.get('/api/reports/hours', (req, res) => {
    const u = currentUser(res);
    const from = isoDate(req.query.from, 'from'), to = isoDate(req.query.to, 'to');
    if (Date.parse(to) <= Date.parse(from)) throw new HttpError(400, 'to must be after from.');
    if (Date.parse(to) - Date.parse(from) > 366 * 86400_000) throw new HttpError(400, 'Choose a range of at most one year.');
    const groupBy = String(req.query.groupBy ?? 'user');
    if (!['user', 'project', 'day'].includes(groupBy)) throw new HttpError(400, 'groupBy must be user, project or day.');
    const format = String(req.query.format ?? 'json');
    if (!['json', 'csv'].includes(format)) throw new HttpError(400, 'format must be json or csv.');
    const userId = req.query.userId ? String(req.query.userId) : null;
    if (userId && !canSeeUser(ctx.db, u, userId)) throw new HttpError(403, 'You cannot view this user.');
    const tz = Math.max(-840, Math.min(840, Number(req.query.tzOffsetMinutes ?? 0) || 0)); // minutes east of UTC
    const visible = visibleUserIds(ctx.db, u);
    const rows = (ctx.db.prepare(`SELECT e.*, u.name user_name, p.name project_name FROM time_entries e JOIN users u ON u.id = e.user_id LEFT JOIN projects p ON p.id = e.project_id
      WHERE e.start_at >= ? AND e.start_at < ? AND e.status != 'rejected' AND e.end_at IS NOT NULL AND (? IS NULL OR e.user_id = ?)`).all(from, to, userId, userId) as Row[]).filter(x => visible === null || visible.has(x.user_id));

    const groups = new Map<string, { key: string; label: string; trackedMs: number; idleMs: number; approvedMs: number; pendingMs: number; entries: number }>();
    for (const x of rows) {
      const key = groupBy === 'user' ? x.user_id : groupBy === 'project' ? (x.project_id ?? 'none') : new Date(Date.parse(x.start_at) + tz * 60_000).toISOString().slice(0, 10);
      const label = groupBy === 'user' ? x.user_name : groupBy === 'project' ? (x.project_name ?? 'No project') : key;
      const g = groups.get(key) ?? { key, label, trackedMs: 0, idleMs: 0, approvedMs: 0, pendingMs: 0, entries: 0 };
      g.trackedMs += x.tracked_ms; g.idleMs += x.idle_ms; g.entries += 1;
      if (x.status === 'approved') g.approvedMs += x.tracked_ms; else g.pendingMs += x.tracked_ms;
      groups.set(key, g);
    }
    const list = [...groups.values()].sort((a, b) => groupBy === 'day' ? a.key.localeCompare(b.key) : b.trackedMs - a.trackedMs);
    const total = list.reduce((t, g) => ({ trackedMs: t.trackedMs + g.trackedMs, idleMs: t.idleMs + g.idleMs, approvedMs: t.approvedMs + g.approvedMs, pendingMs: t.pendingMs + g.pendingMs, entries: t.entries + g.entries }), { trackedMs: 0, idleMs: 0, approvedMs: 0, pendingMs: 0, entries: 0 });
    if (format === 'csv') {
      audit(ctx.db, ctx.cfg, u.id, 'report.exported', 'report', groupBy, { from, to, userId });
      const header = ['Group', 'Tracked hours', 'Idle hours (estimate)', 'Approved hours', 'Pending hours', 'Entries'];
      const lines = [header.map(csvCell).join(','), ...list.map(g => [g.label, hours(g.trackedMs), hours(g.idleMs), hours(g.approvedMs), hours(g.pendingMs), g.entries].map(csvCell).join(',')), ['Total', hours(total.trackedMs), hours(total.idleMs), hours(total.approvedMs), hours(total.pendingMs), total.entries].map(csvCell).join(',')];
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="hours-by-${groupBy}.csv"`, 'Cache-Control': 'no-store' }).send(lines.join('\r\n') + '\r\n');
      return;
    }
    send(res, 200, { from, to, groupBy, groups: list, total, note: 'Idle time is an input-activity estimate. It is included in tracked time and is not a productivity or pay determination.' });
  });

  r.get('/api/reports/activity', (req, res) => {
    const u = currentUser(res);
    const from = isoDate(req.query.from, 'from'), to = isoDate(req.query.to, 'to');
    if (Date.parse(to) <= Date.parse(from)) throw new HttpError(400, 'to must be after from.');
    if (Date.parse(to) - Date.parse(from) > 366 * 86400_000) throw new HttpError(400, 'Choose a range of at most one year.');
    const groupBy = String(req.query.groupBy ?? 'user');
    if (!['user', 'project', 'day'].includes(groupBy)) throw new HttpError(400, 'groupBy must be user, project or day.');
    const format = String(req.query.format ?? 'json');
    if (!['json', 'csv'].includes(format)) throw new HttpError(400, 'format must be json or csv.');
    const userId = req.query.userId ? String(req.query.userId) : null;
    if (userId && !canSeeUser(ctx.db, u, userId)) throw new HttpError(403, 'You cannot view this user.');
    const tz = Math.max(-840, Math.min(840, Number(req.query.tzOffsetMinutes ?? 0) || 0));
    const visible = visibleUserIds(ctx.db, u);
    const rows = (ctx.db.prepare(`SELECT e.id, e.user_id, e.project_id, e.start_at, e.tracked_ms, e.status,
        u.name user_name, p.name project_name, SUM(a.active_seconds) active_seconds,
        SUM(a.duration_seconds) sampled_seconds, SUM(a.keyboard_count) keyboard_count,
        SUM(a.mouse_count) mouse_count, SUM(a.slice_count) slice_count
      FROM time_entries e JOIN users u ON u.id=e.user_id LEFT JOIN projects p ON p.id=e.project_id
      JOIN activity_daily_rollups a ON a.user_id=e.user_id AND a.entry_client_id=e.client_id
      WHERE e.start_at >= ? AND e.start_at < ? AND e.status != 'rejected' AND e.end_at IS NOT NULL
        AND e.activity_enabled=1 AND (? IS NULL OR e.user_id=?)
      GROUP BY e.id ORDER BY e.start_at`).all(from, to, userId, userId) as Row[])
      .filter(row => visible === null || visible.has(row.user_id));
    if (u.role !== 'owner') for (const row of rows) if (row.user_id !== u.id) audit(ctx.db, ctx.cfg, u.id, 'activity.viewed', 'time_entry', row.id, {estimate: true, report: true});

    const groups = new Map<string, {key:string; label:string; trackedMs:number; activeSeconds:number; sampledSeconds:number; keyboardCount:number; mouseCount:number; entries:number}>();
    for (const row of rows) {
      const key = groupBy === 'user' ? row.user_id : groupBy === 'project' ? (row.project_id ?? 'none') : new Date(Date.parse(row.start_at) + tz * 60_000).toISOString().slice(0, 10);
      const label = groupBy === 'user' ? row.user_name : groupBy === 'project' ? (row.project_name ?? 'No project') : key;
      const group = groups.get(key) ?? {key, label, trackedMs:0, activeSeconds:0, sampledSeconds:0, keyboardCount:0, mouseCount:0, entries:0};
      group.trackedMs += row.tracked_ms; group.activeSeconds += row.active_seconds ?? 0; group.sampledSeconds += row.sampled_seconds ?? 0;
      group.keyboardCount += row.keyboard_count ?? 0; group.mouseCount += row.mouse_count ?? 0; group.entries++;
      groups.set(key, group);
    }
    const list = [...groups.values()].map(group => ({...group, activityPercent: group.sampledSeconds ? Math.round(group.activeSeconds / group.sampledSeconds * 100) : null}))
      .sort((a,b) => groupBy === 'day' ? a.key.localeCompare(b.key) : b.trackedMs - a.trackedMs);
    const total = list.reduce((sum, group) => ({trackedMs:sum.trackedMs+group.trackedMs, activeSeconds:sum.activeSeconds+group.activeSeconds,
      sampledSeconds:sum.sampledSeconds+group.sampledSeconds, keyboardCount:sum.keyboardCount+group.keyboardCount,
      mouseCount:sum.mouseCount+group.mouseCount, entries:sum.entries+group.entries}),
      {trackedMs:0,activeSeconds:0,sampledSeconds:0,keyboardCount:0,mouseCount:0,entries:0});
    const activityPercent = total.sampledSeconds ? Math.round(total.activeSeconds / total.sampledSeconds * 100) : null;
    if (format === 'csv') {
      audit(ctx.db, ctx.cfg, u.id, 'report.exported', 'report', `activity-${groupBy}`, {from,to,userId});
      const header = ['Group','Tracked hours','Active seconds','Sampled seconds','Activity estimate (%)','Keyboard key-down count','Mouse click count','Entries'];
      const lines = [header.map(csvCell).join(','), ...list.map(group => [group.label,hours(group.trackedMs),group.activeSeconds,group.sampledSeconds,group.activityPercent,group.keyboardCount,group.mouseCount,group.entries].map(csvCell).join(',')),
        ['Total',hours(total.trackedMs),total.activeSeconds,total.sampledSeconds,activityPercent,total.keyboardCount,total.mouseCount,total.entries].map(csvCell).join(',')];
      res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="activity-by-${groupBy}.csv"`,'Cache-Control':'no-store'}).send(lines.join('\r\n')+'\r\n');
      return;
    }
    send(res, 200, {from,to,groupBy,groups:list,total:{...total,activityPercent},note:'Activity is an opt-in, count-only estimate from sampled minutes. It is not a measure of productivity, quality, attendance, or pay.'});
  });

  r.get('/api/reports/activity/daily', (req, res) => {
    const u=currentUser(res), from=parseDateOnly(req.query.from), to=parseDateOnly(req.query.to);
    if (!from || !to) throw new HttpError(400,'from and to must be YYYY-MM-DD UTC dates.');
    const span=(Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86_400_000;
    if (span<0) throw new HttpError(400,'to must be on or after from.');
    if (span>365) throw new HttpError(400,'Choose a range of at most 366 calendar days.');
    const groupBy=String(req.query.groupBy??'user');
    if (!['user','project','day'].includes(groupBy)) throw new HttpError(400,'groupBy must be user, project or day.');
    const format=String(req.query.format??'json');
    if (!['json','csv'].includes(format)) throw new HttpError(400,'format must be json or csv.');
    const userId=req.query.userId?String(req.query.userId):null;
    if (userId && !canSeeUser(ctx.db,u,userId)) throw new HttpError(403,'You cannot view this user.');
    const visible=visibleUserIds(ctx.db,u);
    const raw=ctx.db.prepare(`SELECT r.utc_date,e.id entry_id,e.user_id,e.project_id,e.status,
        u.name user_name,p.name project_name,r.slice_count,r.duration_seconds,r.active_seconds,r.keyboard_count,r.mouse_count
      FROM activity_daily_rollups r JOIN time_entries e ON e.user_id=r.user_id AND e.client_id=r.entry_client_id
      JOIN users u ON u.id=e.user_id LEFT JOIN projects p ON p.id=e.project_id
      WHERE r.utc_date>=? AND r.utc_date<=? AND e.status!='rejected' AND e.activity_enabled=1 AND (? IS NULL OR e.user_id=?)
      ORDER BY r.utc_date,e.start_at`).all(from,to,userId,userId) as Row[];
    const rows=raw.filter(row=>visible===null||visible.has(row.user_id));
    const viewed=new Set<string>();
    if (u.role!=='owner') for (const row of rows) if (row.user_id!==u.id) viewed.add(row.entry_id);
    for (const id of viewed) audit(ctx.db,ctx.cfg,u.id,'activity.viewed','time_entry',id,{estimate:true,dailyRollup:true});
    const grouped=new Map<string,{date:string;key:string;label:string;activeSeconds:number;sampledSeconds:number;keyboardCount:number;mouseCount:number;entries:Set<string>}>();
    for (const row of rows) {
      const dimension=groupBy==='user'?row.user_id:groupBy==='project'?(row.project_id??'none'):'all';
      const label=groupBy==='user'?row.user_name:groupBy==='project'?(row.project_name??'No project'):'All visible people';
      const key=`${row.utc_date}:${dimension}`;
      const group=grouped.get(key)??{date:row.utc_date,key:dimension,label,activeSeconds:0,sampledSeconds:0,keyboardCount:0,mouseCount:0,entries:new Set<string>()};
      group.activeSeconds+=row.active_seconds;group.sampledSeconds+=row.duration_seconds;group.keyboardCount+=row.keyboard_count;group.mouseCount+=row.mouse_count;group.entries.add(row.entry_id);grouped.set(key,group);
    }
    const list=[...grouped.values()].map(group=>({date:group.date,key:group.key,label:group.label,activeSeconds:group.activeSeconds,sampledSeconds:group.sampledSeconds,
      activityPercent:group.sampledSeconds?Math.round(group.activeSeconds/group.sampledSeconds*100):null,keyboardCount:group.keyboardCount,mouseCount:group.mouseCount,entries:group.entries.size}))
      .sort((a,b)=>a.date.localeCompare(b.date)||a.label.localeCompare(b.label));
    const total=list.reduce((sum,group)=>({activeSeconds:sum.activeSeconds+group.activeSeconds,sampledSeconds:sum.sampledSeconds+group.sampledSeconds,
      keyboardCount:sum.keyboardCount+group.keyboardCount,mouseCount:sum.mouseCount+group.mouseCount,entries:sum.entries+group.entries}),
      {activeSeconds:0,sampledSeconds:0,keyboardCount:0,mouseCount:0,entries:0});
    const note='Daily aggregates are bucketed by UTC date from opt-in sampled counts. They are activity estimates, not productivity, attendance, or pay evidence.';
    if (format==='csv') {
      audit(ctx.db,ctx.cfg,u.id,'report.exported','report','activity-daily',{from,to,userId,groupBy});
      const header=['UTC date','Group','Activity estimate (%)','Active seconds','Sampled seconds','Keyboard key-down count','Mouse click count','Entries','Report note'];
      const lines=[header.map(csvCell).join(','),...list.map(row=>[row.date,row.label,row.activityPercent,row.activeSeconds,row.sampledSeconds,row.keyboardCount,row.mouseCount,row.entries,note].map(csvCell).join(','))];
      res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="activity-daily-by-${groupBy}.csv"`,'Cache-Control':'no-store'}).send(lines.join('\r\n')+'\r\n');
      return;
    }
    send(res,200,{from,to,groupBy,groups:list,total:{...total,activityPercent:total.sampledSeconds?Math.round(total.activeSeconds/total.sampledSeconds*100):null},note});
  });

  r.get('/api/reports/attendance', (req, res) => {
    const u = currentUser(res);
    const from = parseDateOnly(req.query.from), to = parseDateOnly(req.query.to);
    if (!from || !to) throw new HttpError(400, 'from and to must be YYYY-MM-DD calendar dates.');
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (span < 0) throw new HttpError(400, 'to must be on or after from.');
    if (span > 30) throw new HttpError(400, 'Choose a range of at most 31 calendar days.');
    const format = String(req.query.format ?? 'json');
    if (!['json','csv'].includes(format)) throw new HttpError(400, 'format must be json or csv.');
    const userId = req.query.userId ? String(req.query.userId) : null;
    if (userId && !canSeeUser(ctx.db, u, userId)) throw new HttpError(403, 'You cannot view this user.');
    const visible = visibleUserIds(ctx.db, u);
    const people = (ctx.db.prepare('SELECT id,name,team_id FROM users WHERE active=1 ORDER BY name COLLATE NOCASE').all() as Row[])
      .filter(person => (visible === null || visible.has(person.id)) && (!userId || person.id === userId));
    const policies = new Map(people.map(person => [person.id, effectivePolicy(ctx.db, {id:person.id,teamId:person.team_id})]));
    const minStart = Date.parse(`${from}T00:00:00Z`) - 30 * 86_400_000;
    const maxEnd = Date.parse(`${addDateDays(to,1)}T00:00:00Z`) + 14 * 3_600_000;
    const entries = ctx.db.prepare(`SELECT id,user_id,start_at,end_at,tracked_ms,status FROM time_entries
      WHERE source='tracker' AND status!='rejected' AND start_at < ? AND COALESCE(end_at,?) > ? ORDER BY start_at`)
      .all(new Date(maxEnd).toISOString(), new Date(ctx.cfg.now()).toISOString(), new Date(minStart).toISOString()) as Row[];
    const now = ctx.cfg.now(), rows: any[] = [], viewedEntryIds = new Set<string>();
    for (let date = from; date <= to; date = addDateDays(date,1)) {
      const day = weekday(date);
      for (const person of people) {
        const policy = policies.get(person.id)!;
        if (!policy.workScheduleEnabled || !policy.workDays.includes(day)) continue;
        const start = localDateTimeToMs(date, policy.workStartLocal, policy.workTimeZone);
        const end = localDateTimeToMs(date, policy.workEndLocal, policy.workTimeZone);
        const dayStart = localDateTimeToMs(date, '00:00', policy.workTimeZone);
        const dayEnd = localDateTimeToMs(addDateDays(date,1), '00:00', policy.workTimeZone);
        const ownEntries: Array<{id:string;user_id:string;start_at:string;end_at:string|null;tracked_ms:number;status:string;startMs:number;endMs:number}> = entries.filter(entry => entry.user_id === person.id).map(entry => ({
          id:entry.id,user_id:entry.user_id,start_at:entry.start_at,end_at:entry.end_at,tracked_ms:entry.tracked_ms,status:entry.status,
          startMs:Date.parse(entry.start_at), endMs:entry.end_at ? Date.parse(entry.end_at) : now,
        })).filter(entry => entry.startMs < dayEnd && entry.endMs > dayStart);
        let trackedMs = 0, scheduledMs = 0, firstStart: number | null = null, active = false;
        for (const entry of ownEntries) {
          const elapsed = Math.max(1, entry.endMs - entry.startMs);
          const overlap = Math.max(0, Math.min(entry.endMs,dayEnd)-Math.max(entry.startMs,dayStart));
          const shiftOverlap = Math.max(0, Math.min(entry.endMs,end)-Math.max(entry.startMs,start));
          trackedMs += entry.tracked_ms * overlap / elapsed;
          scheduledMs += entry.tracked_ms * shiftOverlap / elapsed;
          if (entry.startMs < dayEnd && (firstStart === null || entry.startMs < firstStart)) firstStart = entry.startMs;
          if (!entry.end_at && entry.startMs < now && now < end && now >= start) active = true;
        }
        if (u.role !== 'owner' && person.id !== u.id) for (const entry of ownEntries) viewedEntryIds.add(entry.id);
        const lateAt = start + policy.lateGraceMinutes * 60_000;
        const status = start > now ? 'upcoming' : active ? 'in_progress' : firstStart === null ? 'no_tracked_session' : firstStart > lateAt ? 'late' : 'tracked';
        rows.push({userId:person.id,name:person.name,date,timeZone:policy.workTimeZone,scheduledStart:policy.workStartLocal,scheduledEnd:policy.workEndLocal,
          lateGraceMinutes:policy.lateGraceMinutes,status,firstTrackedAt:firstStart === null ? null : new Date(firstStart).toISOString(),
          trackedMs:Math.round(trackedMs),trackedWithinScheduleMs:Math.round(scheduledMs),trackedOutsideScheduleEstimateMs:Math.round(Math.max(0,trackedMs-scheduledMs))});
      }
    }
    for (const entryId of viewedEntryIds) audit(ctx.db, ctx.cfg, u.id, 'attendance.evidence.viewed', 'time_entry', entryId, {report:true, estimate:true});
    if (format === 'csv') {
      audit(ctx.db, ctx.cfg, u.id, 'report.exported', 'report', 'attendance', {from,to,userId,estimate:true});
      const note='Tracker records only; no tracked session does not establish absence. Prorated estimates are not payroll evidence.';
      const header=['Person','Date','Status','Timezone','Scheduled start','Scheduled end','Grace minutes','First tracked at','Tracked hours estimate','Within schedule hours estimate','Outside schedule hours estimate','Report note'];
      const lines=[header.map(csvCell).join(','),...rows.map(row=>[row.name,row.date,row.status,row.timeZone,row.scheduledStart,row.scheduledEnd,row.lateGraceMinutes,row.firstTrackedAt,hours(row.trackedMs),hours(row.trackedWithinScheduleMs),hours(row.trackedOutsideScheduleEstimateMs),note].map(csvCell).join(','))];
      res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="attendance-evidence.csv"','Cache-Control':'no-store'}).send(lines.join('\r\n')+'\r\n');
      return;
    }
    send(res,200,{from,to,rows,note:'This report shows tracker records only. “No tracked session” does not establish absence. Time inside/outside schedule is estimated by prorating tracked time across each entry’s elapsed interval; it is not payroll evidence.'});
  });

  return r;
}
