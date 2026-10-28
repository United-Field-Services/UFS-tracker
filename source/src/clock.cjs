'use strict';
const fs = require('node:fs');
// /proc/uptime includes suspend time. Linux performance.now() does not.
// https://man7.org/linux/man-pages/man5/proc_uptime.5.html
function createCaptureClock({platform = process.platform, read = () => fs.readFileSync('/proc/uptime', 'utf8'), monotonic = () => performance.now(), onFailure = () => {}} = {}) {
  let last = 0, failure = null;
  const clock = {
    get failure() {return failure;},
    now() {
      if (failure) return last; // Stable only for shutdown/UI, never used to authorize a new start.
      try {
        let next;
        if (platform === 'linux') {
          const fields = String(read()).trim().split(/\s+/);
          if (fields.length !== 2 || !fields.every(v => /^\d+(?:\.\d+)?$/.test(v))) throw new Error('Invalid Linux uptime clock.');
          next = Number(fields[0]) * 1000;
        } else next = monotonic();
        if (!Number.isFinite(next) || next < last || next < 0) throw new Error('The monotonic clock is invalid or moved backward.');
        last = next;
      } catch (error) {
        failure = `Reliable timing is unavailable: ${error.message}. Quit and reopen the app before another test.`;
        onFailure(failure); // Latch first: stopping and rendering can safely read this clock again.
        throw new Error(failure); // Abort the original method; shutdown may have invalidated its state.
      }
      return last;
    },
    assertHealthy() {clock.now(); if (failure) throw new Error(failure);}
  };
  return clock;
}
module.exports = {createCaptureClock};
