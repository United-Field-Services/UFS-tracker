'use strict';
// Break records: derived from the session's visible event log. A break starts when the employee chooses "Take a break"
// (a pause with kind 'break') and ends when tracking is resumed or the session stops. Nothing here reads input, apps or
// the screen; it only restates pauses the employee made on purpose.
const MAX_BREAKS = 200;

/** [{startAt, endAt}] (endAt null while the break is still going). Ignores zero-length breaks. */
function breaksOf(events, endedAt = null) {
  const list = []; let open = null;
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event.at !== 'string') continue;
    if (event.type === 'paused' && event.kind === 'break' && !open) open = event.at;
    else if (open && (event.type === 'tracking-started' || event.type === 'stopped')) { if (Date.parse(event.at) > Date.parse(open)) list.push({startAt: open, endAt: event.at}); open = null; }
  }
  if (open) {
    if (endedAt && Date.parse(endedAt) > Date.parse(open)) list.push({startAt: open, endAt: endedAt});
    else if (!endedAt) list.push({startAt: open, endAt: null});
  }
  return list.slice(-MAX_BREAKS);
}

module.exports = {breaksOf, MAX_BREAKS};
