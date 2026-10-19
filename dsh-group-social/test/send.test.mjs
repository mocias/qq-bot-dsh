import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GroupImageSender, SEND_MAX_IMAGES, SEND_MAX_CAPTION } from '../lib/send.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 2)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 3)]);

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-group-send-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('qq-group-send-'));
    fs.rmSync(path.resolve(base), { recursive: true, force: true });
  });
  const workspace = path.join(base, 'group');
  for (const dir of ['media', '.memory', '.runtime', 'notes']) fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'media', 'a.png'), PNG);
  fs.writeFileSync(path.join(workspace, 'media', 'b.jpg'), JPEG);
  fs.writeFileSync(path.join(workspace, '.memory', 'PERSONA.md'), 'GROUP_BASE_PERSONA');
  fs.writeFileSync(path.join(workspace, 'notes', 'secret.md'), 'PLAINTEXT_CANARY');
  const outside = path.join(base, 'private', 'soul.png');
  fs.mkdirSync(path.dirname(outside), { recursive: true });
  fs.writeFileSync(outside, PNG);
  const sent = [];
  const audits = [];
  const api = { async sendSegments(chat, segments) { sent.push({ chat, segments }); return { message_id: String(9000 + sent.length) }; } };
  const sender = new GroupImageSender(workspace, { api, audit: (event, extra) => audits.push({ event, ...extra }) });
  return { base, workspace, outside, sent, audits, sender };
}

test('a workspace image is base64-encoded and sent as one image segment', async t => {
  const f = fixture(t);
  const result = await f.sender.send({ sources: ['media/a.png'], caption: '看图', chat: 'group:100000003' });
  assert.equal(result.sent, true);
  assert.equal(result.message_id, '9001');
  assert.equal(result.images[0].mediaType, 'image/png');
  assert.equal(result.images[0].name, 'media/a.png');
  const { segments } = f.sent[0];
  assert.equal(segments.length, 2);
  assert.deepEqual(segments[0], { type: 'text', data: { text: '看图' } });
  assert.equal(segments[1].type, 'image');
  assert.ok(segments[1].data.file.startsWith('base64://'));
  assert.deepEqual(Buffer.from(segments[1].data.file.slice(9), 'base64'), PNG);
});

test('multiple images and an absolute in-workspace path both work', async t => {
  const f = fixture(t);
  const absolute = path.join(f.workspace, 'media', 'b.jpg');
  const result = await f.sender.send({ sources: ['media/a.png', absolute], chat: 'group:100000003' });
  assert.equal(result.images.length, 2);
  assert.deepEqual(f.sent[0].segments.map(segment => segment.type), ['image', 'image']);
  assert.equal(result.images[1].name, 'media/b.jpg');
});

test('a public http(s) URL passes through without being downloaded', async t => {
  const f = fixture(t);
  const result = await f.sender.send({ sources: ['https://example.com/pic.png'], chat: 'group:100000003' });
  assert.equal(result.images[0].kind, 'url');
  assert.deepEqual(f.sent[0].segments[0], { type: 'image', data: { url: 'https://example.com/pic.png' } });
});

test('private addresses, credentials and non-http schemes are refused', async t => {
  const f = fixture(t);
  for (const url of ['http://127.0.0.1/a.png', 'http://localhost/a.png', 'http://192.168.1.5/a.png',
    'http://10.0.0.1/a.png', 'http://foo.local/a.png', 'file:///C:/a.png', 'ftp://x/a.png',
    'https://user:pass@example.com/a.png']) {
    await assert.rejects(() => f.sender.send({ sources: [url], chat: 'group:100000003' }), /public http\(s\)/, url);
  }
  assert.equal(f.sent.length, 0);
});

test('files outside the workspace and protected directories are refused', async t => {
  const f = fixture(t);
  for (const source of ['.memory/PERSONA.md', '.runtime/status.json', 'notes/secret.md',
    f.outside, '../../private/soul.png', 'C:/Windows/win.ini']) {
    await assert.rejects(() => f.sender.send({ sources: [source], chat: 'group:100000003' }),
      /reserved for the owner|limited to the group workspace|not a regular file|Only JPEG|does not exist/, source);
  }
  assert.equal(f.sent.length, 0);
});

test('non-image content cannot be smuggled out through the image tool', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.workspace, 'media', 'fake.png'), Buffer.from('PLAINTEXT_CANARY'));
  await assert.rejects(() => f.sender.send({ sources: ['media/fake.png'], chat: 'group:100000003' }), /Only JPEG, PNG, GIF and WebP/);
  assert.equal(f.sent.length, 0);
});

test('count, size and caption limits hold', async t => {
  const f = fixture(t);
  const many = Array.from({ length: SEND_MAX_IMAGES + 1 }, () => 'media/a.png');
  await assert.rejects(() => f.sender.send({ sources: many, chat: 'group:100000003' }), /一次最多/);
  await assert.rejects(() => f.sender.send({ sources: [], chat: 'group:100000003' }), /不能为空/);
  await assert.rejects(() => f.sender.send({ sources: ['media/a.png'], caption: 'x'.repeat(SEND_MAX_CAPTION + 1), chat: 'group:100000003' }), /caption 最多/);
  await assert.rejects(() => f.sender.send({ sources: ['media/a.png'], caption: 42, chat: 'group:100000003' }), /caption must be text/);
  assert.equal(f.sent.length, 0);
});

test('an oversized image is refused before it is read into memory', async t => {
  const f = fixture(t);
  const big = path.join(f.workspace, 'media', 'big.png');
  fs.writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]));
  await assert.rejects(() => f.sender.send({ sources: ['media/big.png'], chat: 'group:100000003' }), /8MB/);
});

test('a send is audited without leaking file contents', async t => {
  const f = fixture(t);
  await f.sender.send({ sources: ['media/a.png'], caption: 'hi', chat: 'group:100000003' });
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].event, 'native-image-sent');
  assert.equal(f.audits[0].count, 1);
  const serialized = JSON.stringify(f.audits);
  assert.equal(serialized.includes('GROUP_BASE_PERSONA'), false);
  assert.equal(serialized.includes('PLAINTEXT_CANARY'), false);
});
