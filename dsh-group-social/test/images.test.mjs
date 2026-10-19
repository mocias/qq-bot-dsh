import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { allowedImageUrl, sniffImageMediaType, downloadImage, planRetention, ImageRetention,
  IMAGE_MAX_BYTES, IMAGE_RETENTION_HOURS } from '../lib/images.mjs';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 2)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64, 3)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(64, 4)]);

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-group-images-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(base)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('qq-group-images-'));
    fs.rmSync(path.resolve(base), { recursive: true, force: true });
  });
  const workspace = path.join(base, 'group'), runtime = path.join(workspace, '.runtime');
  fs.mkdirSync(runtime, { recursive: true });
  return { base, workspace, runtime };
}

// A tiny fake attachment store: objects are real files so retention can delete them.
function fakeStore(t, dir) {
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  return {
    objects: new Map(),
    async saveImages(inputs) {
      return inputs.map(input => {
        const file = path.join(dir, `obj-${n++}`);
        fs.writeFileSync(file, input.data);
        const ref = { id: 'sha256:' + path.basename(file), file };
        this.objects.set(ref.id, file);
        return ref;
      });
    },
    imageHostPath(ref) { return this.objects.get(ref.id); },
  };
}

test('image URLs must be plain public http(s) and never local or private', () => {
  for (const ok of ['https://gchat.qpic.cn/a.jpg', 'http://multimedia.nt.qq.com.cn/b.png']) {
    assert.equal(allowedImageUrl(ok), true, ok);
  }
  for (const bad of ['', 'not-a-url', 'file:///C:/secret.jpg', 'ftp://x.com/a.jpg', 'javascript:alert(1)',
    'http://127.0.0.1/a.jpg', 'http://localhost/a.jpg', 'http://192.168.1.5/a.jpg', 'http://10.0.0.2/a.jpg',
    'http://169.254.169.254/latest', 'http://[::1]/a.jpg', 'http://intranet.local/a.jpg',
    'http://user:pass@evil.com/a.jpg', 'https://a.test/x.jpg', 'http://1.2.3.4/a.jpg']) {
    assert.equal(allowedImageUrl(bad), false, bad);
  }
});

test('image format is sniffed from bytes, never from the declared name', () => {
  assert.equal(sniffImageMediaType(JPEG), 'image/jpeg');
  assert.equal(sniffImageMediaType(PNG), 'image/png');
  assert.equal(sniffImageMediaType(GIF), 'image/gif');
  assert.equal(sniffImageMediaType(WEBP), 'image/webp');
  assert.equal(sniffImageMediaType(Buffer.from('<html>nope</html>')), undefined);
  assert.equal(sniffImageMediaType(Buffer.alloc(4)), undefined);
});

test('downloads enforce the byte cap and reject non-image payloads', async t => {
  const { workspace } = fixture(t);
  const fetchOk = async () => new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  const image = await downloadImage('https://gchat.qpic.cn/a.jpg', { fetchImpl: fetchOk });
  assert.equal(image.mediaType, 'image/jpeg');
  assert.equal(image.bytes, JPEG.length);

  const fetchHtml = async () => new Response('<html>not an image</html>', { status: 200 });
  await assert.rejects(() => downloadImage('https://gchat.qpic.cn/a.jpg', { fetchImpl: fetchHtml }), /format is not supported/);

  const big = Buffer.concat([JPEG, Buffer.alloc(IMAGE_MAX_BYTES, 9)]);
  const fetchBig = async () => new Response(big, { status: 200 });
  await assert.rejects(() => downloadImage('https://gchat.qpic.cn/a.jpg', { fetchImpl: fetchBig }), /size limit/);

  const fetch404 = async () => new Response('nope', { status: 404 });
  await assert.rejects(() => downloadImage('https://gchat.qpic.cn/a.jpg', { fetchImpl: fetch404 }), /status 404/);
  await assert.rejects(() => downloadImage('http://127.0.0.1/a.jpg', { fetchImpl: fetchOk }), /not a permitted/);
  assert.ok(workspace);
});

test('retention keeps recent images and drops expired, excess and oversized ones', () => {
  const now = 1_000_000_000_000;
  const hour = 3600 * 1000;
  const items = [
    { ref: { id: 'old' }, at: now - 48 * hour, bytes: 10 },
    { ref: { id: 'fresh-1' }, at: now - 1 * hour, bytes: 10 },
    { ref: { id: 'fresh-2' }, at: now - 2 * hour, bytes: 10 },
    { ref: { id: 'fresh-3' }, at: now - 3 * hour, bytes: 10 },
  ];
  const planned = planRetention(items, now, { retentionHours: 24, maxTracked: 3, maxTotalBytes: 1000 });
  assert.deepEqual(planned.drop.map(x => x.ref.id), ['old']);
  assert.deepEqual(planned.keep.map(x => x.ref.id).sort(), ['fresh-1', 'fresh-2', 'fresh-3']);
  assert.equal(planned.drop[0].reason, 'expired');

  const byCount = planRetention(items, now, { retentionHours: 24, maxTracked: 2, maxTotalBytes: 1000 });
  assert.deepEqual(byCount.drop.map(x => x.ref.id).sort(), ['fresh-3', 'old']);
  assert.equal(byCount.drop.find(x => x.ref.id === 'fresh-3').reason, 'count');

  const byBytes = planRetention(items, now, { retentionHours: 24, maxTracked: 10, maxTotalBytes: 25 });
  assert.deepEqual(byBytes.keep.map(x => x.ref.id).sort(), ['fresh-1', 'fresh-2']);
  assert.equal(byBytes.drop.find(x => x.ref.id === 'fresh-3').reason, 'bytes');
});

test('sweep deletes only objects this plugin tracked, and audits the result', async t => {
  const { workspace, runtime } = fixture(t);
  const store = fakeStore(t, path.join(workspace, '.runtime', 'objects'));
  const [kept] = await store.saveImages([{ data: JPEG, mediaType: 'image/jpeg' }]);
  const [expired] = await store.saveImages([{ data: PNG, mediaType: 'image/png' }]);
  const dropped = [];
  const retention = new ImageRetention(workspace, runtime, { onDrop: info => dropped.push(info) });
  retention.track(kept, { bytes: 10, digest: 'a', messageId: 'm1' });
  retention.track(expired, { bytes: 10, digest: 'b', messageId: 'm2' });
  // Age only the second entry past the retention window.
  retention.state.items.find(x => JSON.stringify(x.ref) === JSON.stringify(expired)).at = Date.now() - 48 * 3600 * 1000;
  retention.save();

  const result = retention.sweep(store);
  assert.equal(result.expired, 1);
  assert.equal(fs.existsSync(store.imageHostPath(expired)), false);
  assert.equal(fs.existsSync(store.imageHostPath(kept)), true);
  assert.equal(retention.stats().tracked, 1);
  assert.ok(dropped[0].removed.length <= 1);
});

test('sweep never removes a shared object with extra hard links', async t => {
  const { workspace, runtime } = fixture(t);
  const store = fakeStore(t, path.join(workspace, '.runtime', 'objects'));
  const [ref] = await store.saveImages([{ data: GIF, mediaType: 'image/gif' }]);
  const hostPath = store.imageHostPath(ref);
  fs.linkSync(hostPath, hostPath + '.shared');
  const retention = new ImageRetention(workspace, runtime);
  retention.track(ref, { bytes: 10, digest: 'c' });
  retention.state.items[0].at = Date.now() - 48 * 3600 * 1000;
  retention.save();
  const result = retention.sweep(store);
  assert.equal(result.removed.length, 0);
  assert.equal(fs.existsSync(hostPath), true);
});

test('manifest survives corrupt JSON and record is idempotent', async t => {
  const { workspace, runtime } = fixture(t);
  const store = fakeStore(t, path.join(workspace, '.runtime', 'objects'));
  const [ref] = await store.saveImages([{ data: WEBP, mediaType: 'image/webp' }]);
  fs.writeFileSync(path.join(runtime, 'media.json'), '{not json', 'utf8');
  const retention = new ImageRetention(workspace, runtime);
  assert.equal(retention.state.items.length, 0);
  assert.equal(retention.track(ref, { bytes: 5, digest: 'd' }), true);
  assert.equal(retention.track(ref, { bytes: 5, digest: 'd' }), false);
  assert.equal(retention.stats().tracked, 1);
  assert.equal(IMAGE_RETENTION_HOURS, 24);
});
