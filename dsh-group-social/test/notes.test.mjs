import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GroupStore, groupWorkspacePath, inProtectedDir } from '../lib/security.mjs';
import { GroupNotes, NOTES_DIRNAME, noteFileName, notePath, NOTE_MAX_BYTES } from '../lib/notes.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-group-notes-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('qq-group-notes-'));
    fs.rmSync(path.resolve(base), { recursive: true, force: true });
  });
  const workspace = path.join(base, 'group'), root = path.join(workspace, '.memory'), runtime = path.join(workspace, '.runtime');
  const persona = path.join(root, 'PERSONA.md');
  const store = new GroupStore(workspace, { root, runtime, persona });
  fs.writeFileSync(persona, 'GROUP_BASE_PERSONA');
  store.write('memory', '已有群内事实');
  const privateFile = path.join(base, 'private', 'SOUL.md');
  fs.mkdirSync(path.dirname(privateFile));
  fs.writeFileSync(privateFile, 'PRIVATE_PERSONA_CANARY');
  return { base, workspace, root, runtime, persona, privateFile, store, notes: new GroupNotes(workspace, { store }) };
}

test('files written inside the workspace round-trip, and bare names land in notes', t => {
  const f = fixture(t);
  const authority = { origin: 'qq', evidenceIds: new Set(['qq-1']) };
  const written = f.notes.execute({ action: 'write', name: 'topics.md', text: '# 群话题\nCS 开黑' }, authority);
  assert.equal(written.written, true);
  assert.equal(written.name, 'notes/topics.md');
  assert.equal(fs.readFileSync(path.join(f.workspace, NOTES_DIRNAME, 'topics.md'), 'utf8'), '# 群话题\nCS 开黑');
  assert.equal(f.notes.execute({ action: 'read', name: 'topics.md' }, authority).text, '# 群话题\nCS 开黑');
  assert.deepEqual(f.notes.execute({ action: 'list' }, authority).entries.map(x => x.name), ['topics.md']);
});

test('the workspace root is readable and writable, including nested directories', t => {
  const f = fixture(t);
  const authority = { origin: 'qq', evidenceIds: new Set(['qq-1']) };
  const written = f.notes.execute({ action: 'write', path: 'media/cover.md', text: '图说明' }, authority);
  assert.equal(written.written, true);
  assert.equal(written.name, 'media/cover.md');
  assert.equal(f.notes.execute({ action: 'read', path: 'media/cover.md' }, authority).text, '图说明');
  // An absolute path inside the workspace is accepted too.
  const absolute = path.join(f.workspace, 'notes', 'abs.md');
  assert.equal(f.notes.execute({ action: 'write', path: absolute, text: 'abs' }, authority).written, true);
  assert.equal(f.notes.execute({ action: 'read', path: absolute }, authority).text, 'abs');
});

test('.memory and .runtime stay off limits even though they sit in the workspace', t => {
  const f = fixture(t);
  const authority = { origin: 'qq', evidenceIds: new Set(['qq-1']) };
  for (const target of ['.memory/PERSONA.md', '.memory/MEMORY.md', '.runtime/status.json', '.runtime/state.json',
    path.join(f.workspace, '.memory', 'policy.json'), '.memory', '.runtime']) {
    assert.throws(() => f.notes.execute({ action: 'write', path: target, text: 'pwn' }, authority),
      /reserved for the owner/, `write must reject ${target}`);
    assert.throws(() => f.notes.execute({ action: 'read', path: target }, authority),
      /reserved for the owner/, `read must reject ${target}`);
  }
  assert.equal(fs.readFileSync(f.persona, 'utf8'), 'GROUP_BASE_PERSONA');
  assert.equal(f.store.read('memory'), '已有群内事实');
});

test('paths outside the workspace are refused', t => {
  const f = fixture(t);
  const authority = { origin: 'qq', evidenceIds: new Set(['qq-1']) };
  for (const target of ['../PERSONA.md', '..\\..\\private\\SOUL.md', 'C:/Windows/win.ini', '/etc/passwd',
    f.privateFile, path.join(f.base, 'private', 'SOUL.md')]) {
    assert.throws(() => f.notes.execute({ action: 'write', path: target, text: 'pwn' }, authority),
      /limited to the group workspace|workspace|outside/, `write must reject ${target}`);
  }
  assert.equal(fs.readFileSync(f.privateFile, 'utf8'), 'PRIVATE_PERSONA_CANARY');
});

test('a name that escapes the workspace root cannot smuggle a path', t => {
  const f = fixture(t);
  const authority = { origin: 'qq', evidenceIds: new Set(['qq-1']) };
  for (const name of ['sub/../../x.md', 'a\u0000.md']) {
    assert.throws(() => f.notes.execute({ action: 'write', name, text: 'x' }, authority),
      /Invalid|paths|workspace|reserved|Only .md/, `name form must reject ${name}`);
  }
  // A slashed name addresses a nested workspace path rather than escaping it.
  assert.equal(f.notes.execute({ action: 'write', name: 'a/b.md', text: 'nested' }, authority).name, 'a/b.md');
  assert.equal(fs.readFileSync(path.join(f.workspace, 'a', 'b.md'), 'utf8'), 'nested');
  // "notes/../x.md" normalises to <workspace>/x.md: inside the fence, so it is
  // allowed and stays in the workspace root rather than escaping it.
  assert.equal(f.notes.execute({ action: 'write', name: 'notes/../x.md', text: 'x' }, authority).name, 'x.md');
  assert.equal(fs.existsSync(path.join(f.workspace, 'x.md')), true);
  // A same-named file inside notes is inert: it can never address the real persona.
  assert.ok(f.notes.execute({ action: 'write', name: 'PERSONA.md', text: 'notes copy' }, authority).written);
  assert.equal(fs.readFileSync(path.join(f.workspace, NOTES_DIRNAME, 'PERSONA.md'), 'utf8'), 'notes copy');
  assert.equal(fs.readFileSync(f.persona, 'utf8'), 'GROUP_BASE_PERSONA');
});

test('symlinks, junctions and hard links are rejected everywhere in the workspace', t => {
  const f = fixture(t);
  const authority = { origin: 'qq', evidenceIds: new Set(['qq-1']) };
  const notesDir = path.join(f.workspace, NOTES_DIRNAME);
  const linked = path.join(notesDir, 'escape.md');
  try {
    fs.symlinkSync(f.privateFile, linked, 'file');
  } catch {
    t.skip('symlink creation is not permitted in this environment');
    return;
  }
  assert.throws(() => f.notes.execute({ action: 'read', name: 'escape.md' }, authority), /links and junctions are forbidden/);
  assert.throws(() => f.notes.execute({ action: 'write', path: 'notes/escape.md', text: 'pwn' }, authority), /links and junctions are forbidden/);
  fs.unlinkSync(linked);
  const hard = path.join(notesDir, 'hard.md');
  fs.linkSync(f.privateFile, hard);
  assert.throws(() => f.notes.execute({ action: 'read', name: 'hard.md' }, authority), /hard links are forbidden/);
});

test('extensions, size and per-turn budgets are still bounded', t => {
  const f = fixture(t);
  const authority = { origin: 'qq', evidenceIds: new Set(['qq-1']) };
  assert.throws(() => f.notes.execute({ action: 'write', name: 'evil.exe', text: 'x' }, authority), /Only .md and .txt/);
  assert.throws(() => f.notes.execute({ action: 'write', name: 'noext', text: 'x' }, authority), /Only .md and .txt|Invalid file name/);
  assert.throws(() => f.notes.execute({ action: 'write', name: 'a'.repeat(90) + '.md', text: 'x' }, authority), /Invalid file name/);
  assert.throws(() => f.notes.execute({ action: 'write', name: 'big.md', text: 'x'.repeat(NOTE_MAX_BYTES + 1) }, authority), /32KB/);
  const ok = { origin: 'qq', evidenceIds: new Set(['qq-1']) };
  f.notes.execute({ action: 'write', name: 'a.md', text: '1' }, ok);
  f.notes.execute({ action: 'write', name: 'b.md', text: '2' }, ok);
  f.notes.execute({ action: 'write', name: 'c.md', text: '3' }, ok);
  assert.throws(() => f.notes.execute({ action: 'write', name: 'd.md', text: '4' }, ok), /write limit reached/);
  assert.throws(() => f.notes.execute({ action: 'delete', name: 'a.md' }, authority), /must be list, read, read_image or write/);
});

test('read_image returns image metadata only for real images inside the workspace', t => {
  const f = fixture(t);
  const authority = { origin: 'qq', evidenceIds: new Set(['qq-1']) };
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
  const file = path.join(f.workspace, 'media', 'a.jpg');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jpeg);
  const result = f.notes.execute({ action: 'read_image', path: 'media/a.jpg' }, authority);
  assert.equal(result.mediaType, 'image/jpeg');
  assert.equal(result.bytes, jpeg.length);
  assert.match(result.text, /media\/a\.jpg/);
  assert.throws(() => f.notes.execute({ action: 'read_image', path: 'notes/topics.md' }, authority), /Only .jpg/);
  assert.throws(() => f.notes.execute({ action: 'read_image', path: '.memory/x.jpg' }, authority), /reserved for the owner/);
});

test('unadmitted turns and unknown arguments are refused', t => {
  const f = fixture(t);
  assert.throws(() => new GroupNotes(f.workspace, { store: f.store }).execute({ action: 'list' }, null), /cannot use group files/);
  assert.throws(() => new GroupNotes(f.workspace, { store: f.store }).execute({ action: 'list' }, { origin: 'context' }), /cannot use group files/);
  const authority = { origin: 'qq', evidenceIds: new Set(['qq-1']) };
  assert.throws(() => f.notes.execute({ action: 'write', name: 'a.md', text: 'x', shell: 'whoami' }, authority), /Unsupported file argument/);
  assert.throws(() => f.notes.execute({ action: 'write', name: 'a.md', text: 'x', append: true }, authority), /Unsupported file argument/);
});

test('writes are audited without leaking persona or private material', t => {
  const f = fixture(t);
  const authority = { origin: 'qq', evidenceIds: new Set(['qq-1']) };
  f.notes.execute({ action: 'write', name: 'memes.md', text: '群梗：句句有回应' }, authority);
  const log = f.store.read('log');
  assert.match(log, /群文件读写/);
  assert.match(log, /memes\.md/);
  assert.equal(log.includes('PRIVATE_PERSONA_CANARY'), false);
  assert.equal(log.includes('GROUP_BASE_PERSONA'), false);
});

test('directory listing hides the protected directories', t => {
  const f = fixture(t);
  const authority = { origin: 'qq', evidenceIds: new Set(['qq-1']) };
  f.notes.execute({ action: 'write', name: 'topics.md', text: 'x' }, authority);
  const listing = f.notes.execute({ action: 'list', path: '.' }, authority);
  const names = listing.entries.map(entry => entry.name);
  assert.ok(names.includes('notes/'), names.join(','));
  assert.equal(names.some(name => name.startsWith('.memory')), false);
  assert.equal(names.some(name => name.startsWith('.runtime')), false);
});

test('name and path helpers reject traversal', () => {
  assert.equal(noteFileName(' top topics.md '), 'top topics.md');
  assert.equal(noteFileName('梗.md'), '梗.md');
  for (const bad of ['', ' ', '.', '..', '../a.md', 'a/b.md', 'a\\b.md', 'C:/a.md', 'a.md.', '-a.md', 'a\u0000.md']) {
    assert.throws(() => noteFileName(bad), /Invalid file name|paths|File names|must be .md/, `must reject ${JSON.stringify(bad)}`);
  }
  assert.equal(noteFileName('a.md '), 'a.md');
  assert.throws(() => notePath(path.join(os.tmpdir(), 'qq-notes-root'), '../x.md'), /Invalid|paths/);
  const root = path.join(os.tmpdir(), 'qq-notes-root');
  assert.equal(inProtectedDir(root, path.join(root, '.memory', 'x.md')), true);
  assert.equal(inProtectedDir(root, path.join(root, '.runtime')), true);
  assert.equal(inProtectedDir(root, path.join(root, 'notes', 'x.md')), false);
  assert.throws(() => groupWorkspacePath(root, '.memory/MEMORY.md'), /reserved for the owner/);
});
