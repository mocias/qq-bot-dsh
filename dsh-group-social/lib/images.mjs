import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { checkedPath, within } from './security.mjs';

// Inbound group images: bounded download, format sniffing, and owner-side
// retention. DSH's attachment store is content-addressed and append-only, so
// this module keeps its own manifest and expires objects it created.
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_MAX_PER_MESSAGE = 4;
export const IMAGE_MAX_PER_TURN = 6;
export const IMAGE_RETENTION_HOURS = 24;
export const IMAGE_MAX_TRACKED = 200;
export const IMAGE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
// Accepted images are also copied here so they survive attachment retention.
export const IMAGE_ARCHIVE_DIRNAME = 'media';

const PUBLIC_HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;

export function sniffImageMediaType(buffer) {
  if (!buffer || buffer.length < 12) return undefined;
  const b = buffer;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  const head6 = b.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

// Group messages carry user-supplied URLs. Accept only plain public http(s) so a
// forged segment cannot turn the downloader into a local-network probe.
export function allowedImageUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2000) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host || isIP(host) || !PUBLIC_HOST.test(host)) return false;
  if (/(?:^|\.)(?:localhost|local|internal|test|invalid|lan)$/.test(host)) return false;
  return true;
}

export async function downloadImage(url, { fetchImpl = fetch, signal, maxBytes = IMAGE_MAX_BYTES } = {}) {
  if (!allowedImageUrl(url)) throw Error('Group image URL is not a permitted public http(s) address');
  const response = await fetchImpl(url, { signal, redirect: 'follow', headers: { accept: 'image/*' } });
  if (!response.ok) throw Error('Group image download failed with status ' + response.status);
  const declared = Number(response.headers?.get?.('content-length') ?? 0);
  if (declared > maxBytes) throw Error('Group image exceeds the download size limit');
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) throw Error('Group image exceeds the download size limit');
    chunks.push(Buffer.from(chunk));
  }
  if (!total) throw Error('Group image download returned no bytes');
  const data = Buffer.concat(chunks, total);
  const mediaType = sniffImageMediaType(data);
  if (!mediaType || !IMAGE_MEDIA_TYPES.includes(mediaType)) throw Error('Group image format is not supported');
  return { data, mediaType, bytes: total, digest: createHash('sha256').update(data).digest('hex') };
}

/**
 * Decide which tracked images to expire. Pure so retention stays testable
 * without touching the filesystem or the DSH attachment store.
 */
export function planRetention(items, now, {
  retentionHours = IMAGE_RETENTION_HOURS, maxTracked = IMAGE_MAX_TRACKED, maxTotalBytes = IMAGE_MAX_TOTAL_BYTES,
} = {}) {
  const cutoff = now - retentionHours * 3600 * 1000;
  const ordered = [...items].sort((a, b) => a.at - b.at);
  const drop = [], keep = [];
  let totalBytes = 0, kept = 0;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const item = ordered[index];
    const expired = !Number.isFinite(item.at) || item.at < cutoff;
    const overCount = kept >= maxTracked;
    const overBytes = totalBytes + (item.bytes ?? 0) > maxTotalBytes;
    if (expired || overCount || overBytes) { drop.push({ ...item, reason: expired ? 'expired' : overCount ? 'count' : 'bytes' }); continue; }
    totalBytes += item.bytes ?? 0;
    kept += 1;
    keep.push(item);
  }
  return { keep, drop };
}

export class ImageRetention {
  constructor(workspace, runtime, { hours = IMAGE_RETENTION_HOURS, maxTracked = IMAGE_MAX_TRACKED,
    maxTotalBytes = IMAGE_MAX_TOTAL_BYTES, onDrop = () => {} } = {}) {
    this.workspace = path.resolve(workspace);
    this.hours = hours;
    this.maxTracked = maxTracked;
    this.maxTotalBytes = maxTotalBytes;
    this.onDrop = onDrop;
    this.file = checkedPath(this.workspace, path.join(path.resolve(runtime), 'media.json'));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.state = this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && Array.isArray(parsed.items)) return { version: 1, items: parsed.items.filter(item => item && typeof item.ref === 'object' && Number.isFinite(item.at)) };
    } catch { /* a corrupt manifest starts empty rather than blocking inbound images */ }
    return { version: 1, items: [] };
  }

  save() {
    const temp = checkedPath(this.workspace, this.file + '.' + process.pid + '.tmp');
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2) + '\n', { encoding: 'utf8', flag: 'w' });
    try { checkedPath(this.workspace, this.file); fs.renameSync(temp, this.file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(checkedPath(this.workspace, temp)); }
  }

  track(ref, { bytes = 0, mediaType = '', digest = '', messageId = '' } = {}) {
    const key = JSON.stringify(ref);
    if (this.state.items.some(item => JSON.stringify(item.ref) === key)) return false;
    this.state.items.push({ ref, at: Date.now(), bytes, mediaType, digest, messageId });
    this.save();
    return true;
  }

  /** Expire objects this plugin stored. Foreign objects are never touched. */
  sweep(attachments, now = Date.now()) {
    const { keep, drop } = planRetention(this.state.items, now, {
      retentionHours: this.hours, maxTracked: this.maxTracked, maxTotalBytes: this.maxTotalBytes });
    const removed = [];
    for (const item of drop) {
      try {
        const hostPath = attachments?.imageHostPath?.(item.ref);
        if (typeof hostPath === 'string' && path.isAbsolute(hostPath)) {
          const stat = fs.existsSync(hostPath) ? fs.lstatSync(hostPath) : undefined;
          // nlink > 1 means another reference shares the object; leave it alone.
          if (stat?.isFile() && stat.nlink === 1) {
            fs.unlinkSync(hostPath);
            removed.push({ digest: item.digest, reason: item.reason });
          }
        }
      } catch { /* an already-removed or foreign object is not an error */ }
    }
    if (drop.length) { this.state.items = keep; this.save(); this.onDrop({ removed, expired: drop.length }); }
    return { removed, expired: drop.length, kept: keep.length };
  }

  /** Copy one accepted image into the workspace so it outlives attachment retention. */
  persist(workspace, { data, mediaType, messageId }) {
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[mediaType];
    if (!ext) throw Error('Unsupported image media type');
    const root = path.resolve(workspace);
    const dir = path.join(root, IMAGE_ARCHIVE_DIRNAME);
    fs.mkdirSync(dir, { recursive: true });
    const safeId = String(messageId ?? '').replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 40) || 'unknown';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = checkedPath(root, path.join(dir, `${stamp}-${safeId}${ext}`));
    fs.writeFileSync(file, data);
    return { path: file, relative: path.relative(root, file).split(path.sep).join('/') };
  }

  stats() { return { tracked: this.state.items.length, hours: this.hours, bytes: this.state.items.reduce((sum, item) => sum + (item.bytes ?? 0), 0) }; }
}
