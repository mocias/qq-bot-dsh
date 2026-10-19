// Run with the installed DSH Electron binary and ELECTRON_RUN_AS_NODE=1.
// Real plugin routing and host message constructors; fake agents and transport.
// No QQ traffic, model requests, or desktop input is performed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { registerHooks } = require('node:module');
const root = process.env.DSH_STEER_TEST_ROOT || path.resolve(__dirname, '..');
const installed = 'C:/Users/YOUR_USER/.dsh/profiles/desktop/node_modules/dsh-onebot-qq';
registerHooks({ resolve(spec, ctx, next) {
  if (spec.startsWith('@deepseek-ai/')) {
    return next(spec, { ...ctx, parentURL: pathToFileURL('D:/DSH NEXT/resources/app.asar/package.json').href });
  }
  try { return next(spec, ctx); } catch (error) {
    if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('file:')) {
      for (const parent of ['D:/DSH NEXT/resources/app.asar/package.json', installed + '/package.json']) {
        try { return next(spec, { ...ctx, parentURL: pathToFileURL(parent).href }); } catch {}
      }
    }
    throw error;
  }
} });

(async () => {
  const { Context } = await import('@deepseek-ai/cordis');
  const { ChatBridge } = await import(pathToFileURL(root + '/lib/bridge.js').href);
  const { MediaStore } = await import(pathToFileURL(root + '/lib/media.js').href);
  const { Transcriber } = await import(pathToFileURL(root + '/lib/stt.js').href);
  async function harness(check, options = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-direct-steer-'));
    const captures = { followups: [], steers: [], cancelled: [], outbound: [], errors: [] };
    const ctx = new Context();
    const deps = {
      ctx,
      connection: { connected: true, selfId: '10002', call: async (action, params) => {
        if (options.call) { const result = await options.call(action, params); if (result !== undefined) return result; }
        captures.outbound.push({ action, params });
        return action === 'get_msg' ? { raw_message: '引用的原话', sender: { nickname: '测试' } } : { message_id: 7 };
      } },
      media: new MediaStore(path.join(tmp, 'media'), 6),
      transcriber: new Transcriber({ enabled: false, engine: 'auto', command: '', args: [], model: 'small', timeoutMs: 10000 }),
      agents: { resume: async () => { throw Error('no test session'); }, create: async options => {
        const agent = {
          session: { id: options.sessionId, seq: 0, header: { cwd: tmp } }, status: 'idle',
          cancel: reason => { captures.cancelled.push(reason); agent.status = 'idle'; },
          followup: message => { captures.followups.push(message); agent.status = 'running'; },
          steer: message => { captures.steers.push(message); agent.status = 'running'; },
          whenIdle: async () => {},
        };
        return { agent, dispose: async () => {} };
      } },
      sessions: { flush: async () => {} },
      config: { botQQ: '10002', ignoreSelf: true, requireMention: true, interimMessages: false,
        sendErrorNotice: true, restrictedMemberPrefix: false, sensitivePatterns: [], mediaDir: tmp,
        maxImageBytes: 8388608, maxVoiceBytes: 15728640, maxFileBytes: 20971520, maxInboundFileBytes: 20971520,
        textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
        agentPreset: 'standard', workspacePath: tmp, directSteerPrivateUsers: ['10001'],
        ...options.config },
      policy: { dmPolicy: 'open', groupPolicy: 'disabled', allowFrom: [], groupAllowFrom: [], adminUsers: [], allowAllUsers: true, requireMention: true },
      log: (level, msg) => { if (level === 'error') captures.errors.push(msg); },
    };
    const bridge = new ChatBridge(deps);
    let id = 1;
    const send = (text, extra = {}) => bridge.handleInbound({ post_type: 'message', message_type: 'private',
      user_id: 10001, self_id: 10002, message_id: id++, time: 1792396800,
      message: [{ type: 'text', data: { text } }], raw_message: text,
      sender: { user_id: 10001, nickname: 'local-test' }, ...extra });
    try { await check({ ...captures, bridge, send, deps }); assert.deepEqual(captures.errors, []); }
    finally { await bridge.stop(); }
  }
  const text = message => message.content.map(block => block.text ?? '').join('');
  const cases = [
    ['new messages immediately use native steer, including a natural-language pause', async () => harness(async h => {
      for (const message of ['启动任务', '补充 A', '补充 B', '先别做了']) await h.send(message);
      assert.equal(h.steers.length, 4); assert.equal(h.followups.length, 0);
      assert.equal(h.cancelled.length, 0);
      assert.equal(h.outbound.filter(x => x.action === 'send_msg').length, 0);
      assert.ok(text(h.steers[3]).includes('先别做了'));
      assert.ok(h.steers.every(x => x.source.kind === 'plugin:dsh-onebot'));
      assert.ok(text(h.steers[0]).includes('2026-10-19T16:00:00+08:00'));
      assert.ok(text(h.steers[0]).includes('Asia/Shanghai'));
    })],
    ['concurrent first messages do not become independent followup turns', async () => harness(async h => {
      await Promise.all(['第一句', '第二句', '第三句'].map(x => h.send(x)));
      assert.equal(h.followups.length, 0); assert.equal(h.steers.length, 3);
      assert.deepEqual(h.steers.map(text).map(x => ['第一句', '第二句', '第三句'].find(w => x.includes(w))), ['第一句', '第二句', '第三句']);
    })],
    ['a quoted message is prepared before native steering', async () => harness(async h => {
      await h.send('开始');
      await h.send('补充', { message: [{ type: 'reply', data: { id: '44' } }, { type: 'text', data: { text: '补充' } }] });
      assert.equal(h.steers.length, 2); assert.equal(h.followups.length, 0);
      assert.ok(text(h.steers[1]).includes('引用的原话'));
    })],
    ['other users and groups keep their existing permissions', async () => harness(async h => {
      await h.send('其他人', { user_id: 20002 });
      await h.send('群消息', { message_type: 'group', group_id: 888 });
      assert.equal(h.steers.length, 0); assert.equal(h.followups.length, 1);
    })],
    ['stop is available only in the selected private conversation, without admin elevation', async () => harness(async h => {
      await h.send('开始'); await h.send('/stop');
      assert.equal(h.cancelled.length, 1);
      await h.send('/permission f');
      await h.send('/stop', { user_id: 20002 });
      assert.equal(h.cancelled.length, 1);
      assert.equal(h.steers.length, 1);
      assert.equal(h.outbound.filter(x => JSON.stringify(x).includes('仅管理员')).length, 2);
    })],
    ['stop discards an older message still waiting for media/quote preparation', async () => {
      let resolveQuote, enteredQuote;
      const entered = new Promise(resolve => { enteredQuote = resolve; });
      await harness(async h => {
        await h.send('开始');
        const pending = h.send('旧要求', { message: [{ type: 'reply', data: { id: '44' } }, { type: 'text', data: { text: '旧要求' } }] });
        await entered; await h.send('/stop'); resolveQuote({ raw_message: '旧引用' }); await pending;
        assert.equal(h.steers.length, 1);
        await h.send('新的要求'); assert.equal(h.steers.length, 2);
      }, { call: action => action === 'get_msg' ? new Promise(resolve => { resolveQuote = resolve; enteredQuote(); }) : undefined });
    }],
    ['missing send time is clearly labelled as receive time', async () => harness(async h => {
      await h.send('没有发送时间', { time: undefined });
      assert.match(text(h.steers[0]), /接收时间.*\+08:00/);
    })],
    ['unconfigured deployments retain the upstream queue behavior', async () => harness(async h => {
      await h.send('开始'); await h.send('补充');
      assert.equal(h.followups.length, 2); assert.equal(h.steers.length, 0);
    }, { config: { directSteerPrivateUsers: [] } })],
  ];
  let failed = 0;
  for (const [name, run] of cases) {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failed++; console.error('FAIL ' + name + '\n' + error.stack); }
  }
  console.log(JSON.stringify({ tests: cases.length, passed: cases.length - failed, failed }));
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
