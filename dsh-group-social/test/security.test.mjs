import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GroupStore, checkedPath, groupToolDenial, isGroupAgent } from '../lib/security.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-group-security-'));
  t.after(() => {
    const resolved = path.resolve(base);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('qq-group-security-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const workspace = path.join(base, 'group'), root = path.join(workspace, '.memory'), runtime = path.join(workspace, '.runtime');
  const persona = path.join(root, 'PERSONA.md');
  fs.mkdirSync(path.join(base, 'private'));
  const privateFile = path.join(base, 'private', 'SOUL.md');
  fs.writeFileSync(privateFile, 'PRIVATE_PERSONA_CANARY');
  const store = new GroupStore(workspace, { root, runtime, persona });
  fs.writeFileSync(persona, 'GROUP_PERSONA');
  return { base, workspace, root, runtime, persona, privateFile, store };
}

test('bridge writes only fixed memory/state/log files; persona and policy remain read-only', t => {
  const f = fixture(t);
  f.store.write('memory', 'public group fact');
  f.store.writeJson('state', { seen: ['123'] });
  f.store.append('log', 'changed group memory\n');
  assert.equal(f.store.read('memory'), 'public group fact');
  assert.deepEqual(f.store.json('state'), { seen: ['123'] });
  for (const key of ['persona', 'policy', '../../private/SOUL.md', '__proto__']) {
    assert.throws(() => f.store.write(key, 'overwrite'));
    assert.throws(() => f.store.append(key, 'overwrite'));
  }
  assert.throws(() => f.store.read('../../private/SOUL.md'));
  assert.equal(fs.readFileSync(f.persona, 'utf8'), 'GROUP_PERSONA');
  assert.equal(fs.readFileSync(f.privateFile, 'utf8'), 'PRIVATE_PERSONA_CANARY');
});

test('rejects traversal, sibling-prefix directories, and out-of-workspace configured files', t => {
  const f = fixture(t);
  for (const p of [f.privateFile, path.join(f.workspace, '..', 'private', 'SOUL.md'), f.workspace + '-other/file']) {
    assert.throws(() => checkedPath(f.workspace, p), /outside/);
  }
  assert.throws(() => new GroupStore(f.workspace, { root: f.root, runtime: f.runtime, persona: f.privateFile }), /outside/);
  assert.throws(() => new GroupStore(f.workspace, { root: f.root, runtime: f.runtime, persona: path.join(f.root, 'MEMORY.md') }), /distinct/);
  assert.throws(() => checkedPath(f.workspace, path.join(f.root, 'PERSONA.md:stream')), /Invalid/);
});

test('directory junction introduced after startup cannot redirect memory writes', t => {
  const f = fixture(t);
  fs.renameSync(f.root, path.join(f.workspace, 'old-memory'));
  fs.symlinkSync(path.join(f.base, 'private'), f.root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => f.store.read('persona'), /links|junctions/);
  assert.throws(() => f.store.write('memory', 'escaped'), /links|junctions/);
  assert.equal(fs.existsSync(path.join(f.base, 'private', 'MEMORY.md')), false);
  assert.equal(fs.readFileSync(f.privateFile, 'utf8'), 'PRIVATE_PERSONA_CANARY');
});

test('hard-linked files cannot expose or overwrite a private persona', t => {
  const f = fixture(t);
  fs.linkSync(f.privateFile, path.join(f.root, 'MEMORY.md'));
  assert.throws(() => f.store.read('memory'), /hard links/);
  assert.throws(() => f.store.write('memory', 'overwrite'), /hard links/);
  assert.equal(fs.readFileSync(f.privateFile, 'utf8'), 'PRIVATE_PERSONA_CANARY');
});

test('configured workspace junction is rejected before any state is written', t => {
  const f = fixture(t), junction = path.join(f.base, 'group-link');
  fs.symlinkSync(path.join(f.base, 'private'), junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new GroupStore(junction, { root: path.join(junction, '.memory'), runtime: path.join(junction, '.runtime'), persona: path.join(junction, 'PERSONA.md') }), /links|junctions/);
  assert.equal(fs.existsSync(path.join(f.base, 'private', '.memory')), false);
});

test('all host tools except the bounded search are denied for group IDs and group workspace sessions', t => {
  const f = fixture(t);
  const agents = [
    { session: { id: 'onebot-group-100000003' } },
    { session: { id: 'companion-group-social-100000003' } },
    { session: { id: 'local-session', header: { cwd: f.workspace } } },
    { session: { id: 'local-child', header: { cwd: path.join(f.workspace, 'subfolder') } } },
  ];
  for (const agent of agents) {
    assert.equal(isGroupAgent(agent, f.workspace), true);
    for (const name of ['read_file', 'write_file', 'apply_patch', 'exec', 'powershell', 'web_fetch', 'web_search', 'browser',
      'mcp__wincu__windows_computer_use_click', 'qq_send_text', 'qq_read_message', 'spawn_agent', 'unknown_tool']) {
      assert.match(groupToolDenial({ agent, name }, f.workspace), /禁用/);
    }
    assert.equal(groupToolDenial({ agent, name: 'qq_group_web_search' }, f.workspace), undefined);
    assert.equal(groupToolDenial({ agent, name: 'qq_group_memory' }, f.workspace), undefined);
  }
  assert.equal(groupToolDenial({ agent: { session: { id: 'onebot-private-100000001', header: { cwd: path.join(f.base, 'private') } } }, name: 'read_file' }, f.workspace), undefined);
});
