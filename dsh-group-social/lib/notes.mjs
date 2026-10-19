import fs from 'node:fs';
import path from 'node:path';
import { checkedPath, groupWorkspacePath, inProtectedDir, within, PROTECTED_DIRS } from './security.mjs';

// Bounded text files inside the group workspace. The model may read and write
// ordinary files anywhere under the workspace root, but .memory/ and
// .runtime/ are fenced off by security.groupWorkspacePath before any I/O.
export const NOTES_DIRNAME = 'notes';
export const NOTE_EXTENSIONS = ['.md', '.txt'];
export const NOTE_MAX_BYTES = 32 * 1024;
export const NOTE_READ_MAX_BYTES = 128 * 1024;
export const NOTE_MAX_FILES = 200;
export const NOTE_MAX_WRITES_PER_TURN = 3;
export const NOTE_MAX_READS_PER_TURN = 12;

const NAME = /^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u;

export function notesRoot(workspace) {
  const root = path.join(path.resolve(workspace), NOTES_DIRNAME);
  if (!within(workspace, root)) throw Error('Group notes directory is outside its workspace');
  return root;
}

export function noteFileName(value) {
  if (typeof value !== 'string') throw Error('Invalid file name');
  const name = value.trim();
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name)) throw Error('Invalid file name');
  if (name.includes('/') || name.includes('\\') || name.includes(':')) throw Error('File names cannot contain paths');
  if (name.startsWith('.') || /[. ]$/.test(name)) throw Error('Invalid file name');
  if (!NAME.test(name)) throw Error('File names may only use letters, numbers, spaces, dots, dashes and underscores');
  const ext = path.extname(name).toLowerCase();
  if (!NOTE_EXTENSIONS.includes(ext)) throw Error('Only .md and .txt files are supported');
  if (!name.slice(0, -ext.length).trim()) throw Error('Invalid file name');
  return name;
}

// Backwards-compatible helper: a bare name resolves inside notes/.
export function notePath(workspace, name) {
  const root = notesRoot(workspace);
  const file = path.join(root, noteFileName(name));
  if (path.dirname(file).toLowerCase() !== root.toLowerCase()) throw Error('Note file must sit directly in the notes directory');
  return checkedPath(workspace, file);
}

function relativeName(workspace, file) {
  return path.relative(path.resolve(workspace), file).split(path.sep).join('/');
}

export class GroupNotes {
  constructor(workspace, { store } = {}) {
    if (!path.isAbsolute(workspace)) throw Error('Group workspace must be absolute');
    this.workspace = path.resolve(workspace);
    this.root = notesRoot(this.workspace);
    this.store = store;
    checkedPath(this.workspace, this.root);
    fs.mkdirSync(this.root, { recursive: true });
    checkedPath(this.workspace, this.root);
  }

  audit(entry) {
    try { this.store?.append('log', `\n## ${new Date().toISOString()} | 群文件读写\n${JSON.stringify(entry, null, 2)}\n`); }
    catch { /* auditing must never block the bounded operation */ }
  }

  /** A bare name stays inside notes/; a path resolves against the workspace. */
  resolve(name, { allowBareName = true } = {}) {
    const value = typeof name === 'string' ? name.trim() : name;
    const first = typeof value === 'string' ? value.split(/[\\/]/)[0].toLowerCase() : '';
    // Naming a protected directory directly must read as owner-reserved, not as
    // a malformed file name, so the refusal cannot be mistaken for a typo.
    if (PROTECTED_DIRS.some(dir => first === dir)) return groupWorkspacePath(this.workspace, value);
    if (typeof value === 'string' && !value.includes('/') && !value.includes('\\') && allowBareName && !path.isAbsolute(value)) {
      return notePath(this.workspace, value);
    }
    return groupWorkspacePath(this.workspace, value);
  }

  list(target) {
    const dir = target ? groupWorkspacePath(this.workspace, target) : this.root;
    const stat = fs.existsSync(dir) ? fs.statSync(dir) : undefined;
    if (!stat?.isDirectory()) throw Error('Directory does not exist');
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(item => {
        const full = path.join(dir, item.name);
        if (inProtectedDir(this.workspace, full)) return false;
        return item.isDirectory() || (item.isFile() && NOTE_EXTENSIONS.includes(path.extname(item.name).toLowerCase()));
      })
      .slice(0, NOTE_MAX_FILES)
      .map(item => {
        const full = path.join(dir, item.name);
        return item.isDirectory()
          ? { name: item.name + '/', kind: 'directory' }
          : { name: item.name, kind: 'file', bytes: fs.statSync(full).size };
      });
    return { directory: relativeName(this.workspace, dir) || '.', entries, count: entries.length,
      protectedDirectories: PROTECTED_DIRS };
  }

  read(name) {
    const file = this.resolve(name);
    if (!fs.existsSync(file)) return { name: relativeName(this.workspace, file), missing: true, text: '' };
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw Error('Target is not a regular file');
    if (stat.size > NOTE_READ_MAX_BYTES) throw Error('File exceeds the read limit');
    const ext = path.extname(file).toLowerCase();
    if (!NOTE_EXTENSIONS.includes(ext)) throw Error('Only .md and .txt files can be read as text');
    return { name: relativeName(this.workspace, file), text: fs.readFileSync(file, 'utf8'), bytes: stat.size };
  }

  /** Read raw image bytes so a vision-capable model can look at a stored picture. */
  readImage(name) {
    const file = this.resolve(name);
    const ext = path.extname(file).toLowerCase();
    const mediaTypes = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
    const mediaType = mediaTypes[ext];
    if (!mediaType) throw Error('Only .jpg/.jpeg/.png/.gif/.webp images are supported');
    if (!fs.existsSync(file)) throw Error('Image file does not exist');
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw Error('Target is not a regular file');
    if (stat.size > 8 * 1024 * 1024) throw Error('Image exceeds the 8MB read limit');
    return { name: relativeName(this.workspace, file), data: fs.readFileSync(file), mediaType, bytes: stat.size };
  }

  write(name, text) {
    const file = this.resolve(name);
    const value = String(text ?? '');
    if (Buffer.byteLength(value, 'utf8') > NOTE_MAX_BYTES) throw Error('Content exceeds the 32KB write limit');
    const ext = path.extname(file).toLowerCase();
    if (!NOTE_EXTENSIONS.includes(ext)) throw Error('Only .md and .txt files can be written');
    if (fs.existsSync(file) && fs.statSync(file).size > NOTE_READ_MAX_BYTES) throw Error('File exceeds the read limit');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = checkedPath(this.workspace, file + '.' + process.pid + '.tmp');
    fs.writeFileSync(temp, value, { encoding: 'utf8', flag: 'wx' });
    try { checkedPath(this.workspace, file); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(checkedPath(this.workspace, temp)); }
    return { name: relativeName(this.workspace, file), bytes: Buffer.byteLength(value, 'utf8'), written: true };
  }

  execute(args, authority) {
    if (!authority || !['qq', 'local-ui'].includes(authority.origin)) throw Error('This turn cannot use group files');
    const action = args?.action;
    const allowed = new Set(['action', 'name', 'path', 'text']);
    if (Object.keys(args ?? {}).some(key => !allowed.has(key))) throw Error('Unsupported file argument; no policy fields are accepted');
    const target = args?.path ?? args?.name;
    if (action === 'list') return this.list(args?.path);
    if (action === 'read') {
      if ((authority.noteReads ?? 0) >= NOTE_MAX_READS_PER_TURN) throw Error('Group file read limit reached for this turn');
      const result = this.read(target);
      authority.noteReads = (authority.noteReads ?? 0) + 1;
      return result;
    }
    if (action === 'read_image') {
      if ((authority.noteReads ?? 0) >= NOTE_MAX_READS_PER_TURN) throw Error('Group file read limit reached for this turn');
      const result = this.readImage(target);
      authority.noteReads = (authority.noteReads ?? 0) + 1;
      this.audit({ action: 'read_image', name: result.name, bytes: result.bytes, origin: authority.origin });
      // The text names the file so the model can cite it; the bytes ride the
      // turn's attachment channel because tool output stays text-only here.
      return { name: result.name, mediaType: result.mediaType, bytes: result.bytes,
        text: `已读取图片 ${result.name}（${result.mediaType}，${result.bytes} 字节），内容见本轮附带的图片。` };
    }
    if (action === 'write') {
      if ((authority.noteWrites ?? 0) >= NOTE_MAX_WRITES_PER_TURN) throw Error('Group file write limit reached for this turn');
      const result = this.write(target, args?.text);
      authority.noteWrites = (authority.noteWrites ?? 0) + 1;
      this.audit({ action: 'write', name: result.name, bytes: result.bytes, origin: authority.origin });
      return result;
    }
    throw Error('File action must be list, read, read_image or write');
  }
}
