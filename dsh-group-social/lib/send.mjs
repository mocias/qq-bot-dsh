import fs from 'node:fs';
import path from 'node:path';
import { groupWorkspacePath } from './security.mjs';
import { allowedImageUrl, sniffImageMediaType, IMAGE_MEDIA_TYPES } from './images.mjs';

// Outbound image sending for the group. Sources are the group workspace (so the
// model can share a picture it archived or produced) and public http(s) URLs.
// Anything else — private chat paths, the owner's profile, other workspaces — is
// refused before the file is read.
export const SEND_MAX_IMAGES = 9;
export const SEND_MAX_BYTES = 8 * 1024 * 1024;
export const SEND_MAX_CAPTION = 500;

export class GroupImageSender {
  constructor(workspace, { api, audit } = {}) {
    this.workspace = path.resolve(workspace);
    this.api = api;
    this.audit = audit ?? (() => {});
  }

  /** Turn one source into an OneBot image segment plus a short description. */
  resolveSource(source) {
    if (typeof source !== 'string' || !source.trim()) throw Error('Image source must be a non-empty string');
    const value = source.trim();
    if (value.length > 2048) throw Error('Image source is too long');
    if (/^https?:\/\//i.test(value)) {
      if (!allowedImageUrl(value)) throw Error('Image URL must be a public http(s) address');
      return { segment: { type: 'image', data: { url: value } }, kind: 'url', name: value };
    }
    // Reject other schemes explicitly so "file://" never reaches the path branch
    // and reads as a plain malformed path.
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
      throw Error('Image source must be a public http(s) address or a workspace file');
    }
    const file = groupWorkspacePath(this.workspace, value);
    if (!fs.existsSync(file)) throw Error('Image file does not exist in the group workspace');
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw Error('Image source is not a regular file');
    if (stat.size > SEND_MAX_BYTES) throw Error('Image exceeds the 8MB send limit');
    const data = fs.readFileSync(file);
    const mediaType = sniffImageMediaType(data);
    if (!mediaType || !IMAGE_MEDIA_TYPES.includes(mediaType)) throw Error('Only JPEG, PNG, GIF and WebP images can be sent');
    return { segment: { type: 'image', data: { file: 'base64://' + data.toString('base64') } },
      kind: 'file', name: path.relative(this.workspace, file).split(path.sep).join('/'), bytes: stat.size, mediaType };
  }

  async send({ sources, caption, chat }) {
    if (!this.api) throw Error('Group OneBot API is unavailable');
    const list = Array.isArray(sources) ? sources.filter(item => typeof item === 'string') : [];
    if (!list.length) throw Error('sources 不能为空');
    if (list.length > SEND_MAX_IMAGES) throw Error(`一次最多 ${SEND_MAX_IMAGES} 张图片`);
    if (caption !== undefined && typeof caption !== 'string') throw Error('caption must be text');
    const text = typeof caption === 'string' ? caption.trim() : '';
    if (text.length > SEND_MAX_CAPTION) throw Error(`caption 最多 ${SEND_MAX_CAPTION} 字`);
    const resolved = list.map(source => this.resolveSource(source));
    const segments = [];
    if (text) segments.push({ type: 'text', data: { text } });
    for (const item of resolved) segments.push(item.segment);
    const result = await this.api.sendSegments(chat, segments);
    const receipt = {
      sent: true, message_id: String(result?.message_id ?? ''), chat_id: chat,
      images: resolved.map(item => ({ kind: item.kind, name: item.name, bytes: item.bytes, mediaType: item.mediaType })),
      caption: text || undefined,
    };
    this.audit('native-image-sent', { chat, message_id: receipt.message_id, count: resolved.length,
      sources: resolved.map(item => item.name) });
    return receipt;
  }
}
