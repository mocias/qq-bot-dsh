import fs from 'node:fs';
import path from 'node:path';
import { checkedPath } from './security.mjs';

// Group long-term memory: durable markdown pages under .memory/, indexed by
// MEMORY.md and injected on every turn. The shape mirrors the private memory
// store (pages + index + log) but stays a separate directory by design, so a
// group turn can never read or reshape the owner's private persona.
export const MEMORY_DIRNAME = '.memory';
export const MEMBER_PAGE = 'members.md';
export const MEMORY_MAX_PAGES = 40;
export const MEMORY_MAX_PAGE_BYTES = 32 * 1024;
export const MEMORY_INJECT_MAX_BYTES = 24 * 1024;
export const MEMORY_MAX_WRITES_PER_TURN = 3;

export function memoryRoot(workspace) {
  return checkedPath(path.resolve(workspace), path.join(path.resolve(workspace), MEMORY_DIRNAME));
}

const PAGE_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

export function memoryPageName(value) {
  if (typeof value !== 'string') throw Error('Invalid memory page name');
  const name = value.trim();
  if (!name || name.length > 60 || /[\x00-\x1f]/.test(name)) throw Error('Invalid memory page name');
  if (/[\\/]/.test(name) || name.includes(':') || name.startsWith('.')) throw Error('Memory pages cannot contain paths');
  const base = name.replace(/\.md$/i, '');
  if (!PAGE_NAME.test(base)) throw Error('Memory page names may only use letters, numbers, dots, dashes and underscores');
  return base + '.md';
}

/** Pages the owner manages directly; the group model may not rewrite them. */
const OWNER_PAGES = new Set(['persona.md', 'policy.md', 'log.md', 'memory.md']);

export class GroupMemoryPages {
  constructor(workspace, store) {
    this.workspace = path.resolve(workspace);
    this.root = memoryRoot(this.workspace);
    this.store = store;
    fs.mkdirSync(this.root, { recursive: true });
    checkedPath(this.workspace, this.root);
  }

  pagePath(name) {
    const file = path.join(this.root, memoryPageName(name));
    if (path.dirname(file).toLowerCase() !== this.root.toLowerCase()) throw Error('Memory page must sit directly in .memory');
    return checkedPath(this.workspace, file);
  }

  list() {
    checkedPath(this.workspace, this.root);
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter(item => item.isFile() && item.name.toLowerCase().endsWith('.md'))
      .map(item => item.name)
      .filter(name => !OWNER_PAGES.has(name.toLowerCase()))
      .slice(0, MEMORY_MAX_PAGES);
  }

  read(name) {
    const file = this.pagePath(name);
    if (!fs.existsSync(file)) return '';
    const stat = fs.statSync(file);
    if (stat.size > MEMORY_MAX_PAGE_BYTES) throw Error('Memory page exceeds the read limit');
    return fs.readFileSync(file, 'utf8');
  }

  /** Group-writable pages only: members.md and other model-owned pages. */
  write(name, text) {
    const page = memoryPageName(name);
    if (OWNER_PAGES.has(page.toLowerCase())) throw Error('That memory page is owned by the computer owner');
    const file = this.pagePath(page);
    const value = String(text ?? '');
    if (Buffer.byteLength(value, 'utf8') > MEMORY_MAX_PAGE_BYTES) throw Error('Memory page exceeds the 32KB limit');
    if (fs.existsSync(file) && !this.list().includes(page) && this.list().length >= MEMORY_MAX_PAGES) {
      throw Error('Memory page limit reached');
    }
    const temp = checkedPath(this.workspace, file + '.' + process.pid + '.tmp');
    fs.writeFileSync(temp, value, { encoding: 'utf8', flag: 'wx' });
    try { checkedPath(this.workspace, file); fs.renameSync(temp, file); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(checkedPath(this.workspace, temp)); }
    return { page, bytes: Buffer.byteLength(value, 'utf8') };
  }

  /**
   * Build the per-turn memory block: the short summary plus every model-owned
   * page, capped so a large memory store cannot crowd out the conversation.
   */
  render(limit = MEMORY_INJECT_MAX_BYTES) {
    const summary = (() => {
      try { return this.store?.read('memory') ?? ''; } catch { return ''; }
    })();
    const pages = [];
    let used = Buffer.byteLength(summary, 'utf8');
    for (const name of this.list()) {
      let text;
      try { text = this.read(name); } catch { continue; }
      if (!text.trim()) continue;
      const cost = Buffer.byteLength(text, 'utf8');
      if (used + cost > limit) continue;
      used += cost;
      pages.push(`### ${name}\n${text.trim()}`);
    }
    return { summary: summary.trim(), pages, bytes: used };
  }
}

export function memoryPrompt(memory) {
  const parts = [];
  if (memory.summary) parts.push('长期摘要：\n' + memory.summary);
  if (memory.pages.length) parts.push('人物与长期页面：\n' + memory.pages.join('\n\n'));
  return parts.length ? parts.join('\n\n') : '（还没有长期记忆，遇到值得记的人和事就用 qq_group_memory 写下来。）';
}
