'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const PNG_HEADER = Buffer.from([137,80,78,71,13,10,26,10]);
function decodePng(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > 36 * 1024 * 1024) throw new Error('Invalid screenshot data.');
  const bytes = Buffer.from(dataUrl.slice(22), 'base64');
  if (bytes.length < 45 || bytes.length > 24 * 1024 * 1024 || !bytes.subarray(0, 8).equals(PNG_HEADER) || bytes.subarray(12, 16).toString() !== 'IHDR') throw new Error('Invalid PNG screenshot.');
  const width = bytes.readUInt32BE(16); const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096) throw new Error('Screenshot dimensions are out of bounds.');
  return { bytes, width, height };
}
// ---- WebP (company sessions) ----
// Electron's nativeImage cannot decode WebP, so the renderer encodes it (and a small JPEG thumbnail) and the main
// process only validates the bytes and sizes here; it never decodes pixels.
function webpSize(bytes) {
  const chunk = bytes.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return {width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff};
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) { const bits = bytes.readUInt32LE(21); return {width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1}; }
  if (chunk === 'VP8X' && bytes.length >= 30) return {width: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), height: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))};
  throw new Error('Invalid WebP screenshot.');
}
/** Accepts a PNG or WebP data URL from the renderer. Returns the bytes, size, file extension and MIME type. */
function decodeScreenshot(dataUrl) {
  if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/webp;base64,')) {
    if (dataUrl.length > 36 * 1024 * 1024) throw new Error('Invalid screenshot data.');
    const bytes = Buffer.from(dataUrl.slice(23), 'base64');
    if (bytes.length < 30 || bytes.length > 24 * 1024 * 1024 || bytes.subarray(0, 4).toString('latin1') !== 'RIFF' || bytes.subarray(8, 12).toString('latin1') !== 'WEBP') throw new Error('Invalid WebP screenshot.');
    const {width, height} = webpSize(bytes);
    if (!width || !height || width > 4096 || height > 4096) throw new Error('Screenshot dimensions are out of bounds.');
    return {bytes, width, height, ext: 'webp', type: 'image/webp'};
  }
  return {...decodePng(dataUrl), ext: 'png', type: 'image/png'};
}
/** Optional JPEG thumbnail from the renderer. Anything wrong with it is ignored: the screenshot itself is what matters. */
function decodeThumbnail(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/jpeg;base64,') || dataUrl.length > 400 * 1024) return null;
  const bytes = Buffer.from(dataUrl.slice(23), 'base64');
  return bytes.length > 3 && bytes.length <= 300 * 1024 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null;
}
const IMAGE_FILE = /\.(png|webp)$/;

class LocalStore {
  constructor(root) { this.root = root; this.screens = path.join(root, 'Screenshots'); this.indexPath = path.join(root, 'sessions.json'); fs.mkdirSync(this.screens, {recursive: true, mode: 0o700}); this.data = { schema: 1, sessions: [], captures: [] }; if (fs.existsSync(this.indexPath)) { const loaded = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')); if (loaded.schema !== 1 || !Array.isArray(loaded.sessions) || !Array.isArray(loaded.captures)) throw new Error('The local tracker index is not valid. Your files have not been overwritten.'); this.data = loaded; } }
  persist() { const temp = `${this.indexPath}.${randomUUID()}.tmp`; fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), {mode: 0o600}); fs.renameSync(temp, this.indexPath); }
  saveSession(session) { if (!session) return; const copy = {...JSON.parse(JSON.stringify(session)), checkpointAt: new Date().toISOString()}; const index = this.data.sessions.findIndex(s => s.id === copy.id); if (index < 0) this.data.sessions.push(copy); else this.data.sessions[index] = copy; this.persist(); }
  recoverInterrupted() {
    let changed = false;
    const counts = new Map();
    for (const capture of this.data.captures) counts.set(capture.sessionId, (counts.get(capture.sessionId) || 0) + 1);
    for (const session of this.data.sessions) {
      const count = counts.get(session.id) || 0;
      if (session.captureCount !== count) {session.captureCount = count; changed = true;}
      if (session.idleReview && Number.isFinite(session.idleReview.baselineIdleMs)) {
        const idleMs = Math.max(0, (session.idleMs || 0) - session.idleReview.baselineIdleMs);
        session.idleMs = Math.max(0, (session.idleMs || 0) - idleMs);
        session.trackedMs = Math.max(0, (session.trackedMs || 0) - idleMs);
        session.events = Array.isArray(session.events) ? session.events : [];
        session.events.push({at: session.checkpointAt || session.events.at(-1)?.at || session.startedAt, type: 'idle-review-discarded', idleMs, reason: 'interrupted'});
        delete session.idleReview; changed = true;
      }
      if (!session.endedAt) {
        session.endedAt = session.checkpointAt || session.events?.at(-1)?.at || session.startedAt;
        session.interrupted = true; changed = true;
      }
    }
    if (changed) this.persist();
  }
  saveCapture(session, dataUrl, canCommit = () => true, thumbnailUrl = null) {
    const ensureAllowed = () => {if (!canCommit()) throw new Error('Screenshot cancelled because capture stopped or its time limit was reached.');};
    ensureAllowed();
    const {bytes, width, height, ext} = decodeScreenshot(dataUrl);
    const thumbBytes = decodeThumbnail(thumbnailUrl);
    ensureAllowed();
    const id = randomUUID(); const takenAt = new Date().toISOString();
    const stem = `${takenAt.replace(/[:.]/g, '-')}_${id}`;
    const fileName = `${stem}.${ext}`; const thumbFileName = thumbBytes ? `${stem}.thumb.jpg` : null;
    const fullPath = path.join(this.screens, fileName);
    const thumbPath = thumbFileName ? path.join(this.screens, thumbFileName) : null;
    const stagingPath = path.join(this.screens, `.pending-${id}`);
    const entry = {id, sessionId: session.id, task: session.task, displayId: session.displayId, takenAt, fileName, width, height, ...(thumbFileName ? {thumbFileName} : {})};
    const index = this.data.sessions.findIndex(saved => saved.id === session.id);
    const previous = index < 0 ? null : this.data.sessions[index];
    const checkpoint = {...JSON.parse(JSON.stringify(session)), captureCount: (session.captureCount || 0) + 1, checkpointAt: takenAt};
    let indexed = false; let indexCommitted = false;
    try {
      ensureAllowed();
      fs.writeFileSync(stagingPath, bytes, {mode: 0o600, flag: 'wx'});
      ensureAllowed();
      fs.renameSync(stagingPath, fullPath);
      if (thumbPath) fs.writeFileSync(thumbPath, thumbBytes, {mode: 0o600});
      ensureAllowed();
      if (index < 0) this.data.sessions.push(checkpoint); else this.data.sessions[index] = checkpoint;
      this.data.captures.push(entry); indexed = true;
      ensureAllowed();
      this.persist(); indexCommitted = true;
      ensureAllowed();
      return entry;
    } catch (error) {
      if (indexed) {
        this.data.captures.pop();
        if (index < 0) this.data.sessions.pop(); else this.data.sessions[index] = previous;
      }
      // Cleanup may occur after the limit; a late PNG is never retained in the gallery.
      if (fs.existsSync(stagingPath)) fs.unlinkSync(stagingPath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      if (indexCommitted) this.persist();
      throw error;
    }
  }

  fileFor(id) { const capture = this.data.captures.find(c => c.id === id); if (!capture || typeof capture.fileName !== 'string' || path.basename(capture.fileName) !== capture.fileName || !IMAGE_FILE.test(capture.fileName)) throw new Error('Screenshot not found.'); return path.join(this.screens, capture.fileName); }
  /** Path of the saved JPEG thumbnail, or null (older captures and WebP captures without one). */
  thumbFor(id) { const capture = this.data.captures.find(c => c.id === id); const name = capture?.thumbFileName; return typeof name === 'string' && path.basename(name) === name && name.endsWith('.thumb.jpg') ? path.join(this.screens, name) : null; }
  /** MIME type of a saved screenshot, from its extension. */
  typeFor(id) { return this.fileFor(id).endsWith('.webp') ? 'image/webp' : 'image/png'; }
  list() { return { sessions: this.data.sessions.slice(-100).reverse(), captures: this.data.captures.slice(-60).reverse(), totalCaptureCount: this.data.captures.length, directory: this.root }; }
}
module.exports = { LocalStore, decodePng, decodeScreenshot, decodeThumbnail };
