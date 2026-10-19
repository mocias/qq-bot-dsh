import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GroupStore } from '../lib/security.mjs';
import { GroupMemoryPages, memoryPrompt, memoryPageName, MEMBER_PAGE, MEMORY_MAX_PAGE_BYTES } from '../lib/members.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-group-pages-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('qq-group-pages-'));
    fs.rmSync(path.resolve(base), { recursive: true, force: true });
  });
  const workspace = path.join(base, 'group'), root = path.join(workspace, '.memory'), runtime = path.join(workspace, '.runtime');
  const persona = path.join(root, 'PERSONA.md');
  const store = new GroupStore(workspace, { root, runtime, persona });
  fs.writeFileSync(persona, 'GROUP_BASE_PERSONA');
  store.write('memory', '群里最近在聊 CS');
  return { base, workspace, root, runtime, persona, store, pages: new GroupMemoryPages(workspace, store) };
}

test('a member page records who is who and survives a round trip', t => {
  const f = fixture(t);
  assert.equal(f.pages.read(MEMBER_PAGE), '');
  const written = f.pages.write(MEMBER_PAGE, '# 群友\n\n- 卷聪 (100000002)：爱接梗，句子短\n');
  assert.equal(written.page, MEMBER_PAGE);
  assert.match(f.pages.read(MEMBER_PAGE), /卷聪/);
  assert.deepEqual(f.pages.list(), [MEMBER_PAGE]);
});

test('the per-turn block injects the summary plus every model-owned page', t => {
  const f = fixture(t);
  f.pages.write(MEMBER_PAGE, '- 卷聪：爱接梗');
  f.pages.write('topics.md', '- CS 开黑');
  const rendered = f.pages.render();
  assert.match(rendered.summary, /CS/);
  const names = rendered.pages.map(part => part.split('\n')[0]);
  assert.deepEqual(names, ['### members.md', '### topics.md']);
  const prompt = memoryPrompt(rendered);
  assert.match(prompt, /长期摘要/);
  assert.match(prompt, /卷聪/);
  assert.match(prompt, /CS 开黑/);
});

test('the injection cap keeps the conversation from being crowded out', t => {
  const f = fixture(t);
  f.pages.write(MEMBER_PAGE, 'x'.repeat(20 * 1024));
  f.pages.write('big.md', 'y'.repeat(20 * 1024));
  const rendered = f.pages.render(24 * 1024);
  assert.ok(rendered.bytes <= 24 * 1024);
  // The first page still fits; the second is skipped rather than overflowing.
  assert.equal(rendered.pages.length, 1);
});

test('owner-managed pages cannot be rewritten by the group model', t => {
  const f = fixture(t);
  for (const name of ['persona.md', 'memory.md', 'policy.md', 'log.md', 'PERSONA.md']) {
    assert.throws(() => f.pages.write(name, 'pwn'), /owned by the computer owner/, name);
  }
  assert.equal(fs.readFileSync(f.persona, 'utf8'), 'GROUP_BASE_PERSONA');
  assert.equal(f.store.read('memory'), '群里最近在聊 CS');
  // The owner's real MEMORY.md and log.md stay untouched as well.
  assert.equal(fs.readFileSync(path.join(f.root, 'MEMORY.md'), 'utf8'), '群里最近在聊 CS');
});

test('page names reject paths, traversal and malformed input', t => {
  assert.equal(memoryPageName('members'), 'members.md');
  assert.equal(memoryPageName('members.md'), 'members.md');
  assert.equal(memoryPageName('梗.md'), '梗.md');
  for (const bad of ['', ' ', '.hidden', '../escape', 'a/b', 'a\\b', 'C:/x.md', 'x'.repeat(80) + '.md', 'a\u0000.md']) {
    assert.throws(() => memoryPageName(bad), /Invalid|paths|only use/, `must reject ${JSON.stringify(bad)}`);
  }
});

test('page size is bounded and empty pages are not injected', t => {
  const f = fixture(t);
  assert.throws(() => f.pages.write('huge.md', 'x'.repeat(MEMORY_MAX_PAGE_BYTES + 1)), /32KB/);
  f.pages.write('blank.md', '   \n');
  const rendered = f.pages.render();
  assert.equal(rendered.pages.some(part => part.startsWith('### blank.md')), false);
});
