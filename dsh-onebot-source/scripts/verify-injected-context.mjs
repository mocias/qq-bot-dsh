#!/usr/bin/env node
/**
 * dsh-onebot 集成验证 ①：插件上下文写入 × 真实 DSH v4 JSONL 落盘（仿 dsh-im
 * verify-injected-context 模式）。
 *
 * 用法：node scripts/verify-injected-context.mjs <宿主构建路径>
 *   例：node scripts/verify-injected-context.mjs /vol2/@appdata/Harness/server/0.2.1-alpha.2
 *
 * 从指定宿主加载会话持久化组件（@deepseek-ai/dsh-session-persistence-jsonl +
 * dsh-llm 的 createUserMessage），按 bridge.js:343（followup）/ bridge.js:503
 * （steer）的同一消息构造形态——producer-owned source kind
 * `plugin:dsh-onebot`——把插件上下文写入真实 DSH v4 JSONL 会话，覆盖：
 *   S1 普通消息（QQ 入站正文）
 *   S2 interim 中间消息（语音转写 steer 通道，同一 source kind）
 *   S3 组合多段文本（媒体注释 + 正文，buildBody 形态）
 *   S4 关闭后重读（write handle close → read handle 重开）
 *   S5 继续写入下一轮（write 重开 → turn 2 → 再关闭 → 再读回）
 *   S6 负向回归：retired source kind `plugin` 必须被 v4 admission 拒绝
 *      （dsh-im README 记载的 SessionFormatError: format v4 message requires
 *      a producer-owned source kind —— 本插件的 kind 选择即该约束的防回归）
 *
 * 行为契约：
 * - 临时会话目录自建自清理（os.tmpdir() 下 mkdtemp，结束 rm -rf 并自验 ENOENT）；
 * - 无需机器人凭据、不发起模型请求、不进入 vitest、不阻塞 CI；
 * - 宿主路径缺失/非法 → usage 报错 exit 1（不静默）；
 * - 宿主 API 缺失（0.1.x–0.2.0 线无 dsh-session-persistence-jsonl 等组件）
 *   → 输出显式 DEGRADE 说明后 exit 0（不崩溃）。
 * 本脚本为 build 产物消费方：只读宿主包与仓库 lib/，不写仓库任何文件。
 * @module dsh-onebot/verify-injected-context
 */
import { createRequire } from 'node:module';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGIN_ROOT = resolve(new URL('..', import.meta.url).pathname);
const PLUGIN_SOURCE_KIND = 'plugin:dsh-onebot';

function usage(message) {
    console.error('用法: node scripts/verify-injected-context.mjs <宿主构建路径>');
    console.error('  <宿主构建路径>: 已安装 dsh 的宿主目录（其下应有 node_modules/@deepseek-ai/），');
    console.error('  例: /vol2/@appdata/Harness/server/0.2.1-alpha.2');
    if (message !== undefined)
        console.error('错误: ' + message);
    process.exit(1);
}

/** 统一的断言收集：单场景失败不中断后续场景，最后汇总决定退出码。 */
const results = [];
function report(id, name, pass, detail) {
    results.push({ id, name, pass });
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + id + ' ' + name + (detail !== undefined ? ' — ' + detail : ''));
}

async function main() {
    const hostPath = process.argv[2];
    if (hostPath === undefined || hostPath === '')
        usage('缺少宿主构建路径参数');
    const host = resolve(hostPath);
    let hostStat;
    try {
        hostStat = await stat(host);
    }
    catch {
        usage('宿主路径不存在: ' + host);
    }
    if (!hostStat.isDirectory())
        usage('宿主路径不是目录: ' + host);
    const hostNodeModules = join(host, 'node_modules');
    if (!existsSync(join(hostNodeModules, '@deepseek-ai')))
        usage('路径下没有 node_modules/@deepseek-ai/，不是 dsh 宿主安装目录: ' + host);
    const jsonlPkgDir = join(hostNodeModules, '@deepseek-ai', 'dsh-session-persistence-jsonl');
    if (!existsSync(jsonlPkgDir)) {
        // 0.1.x–0.2.0 线宿主缺该组件：显式降级说明，不崩溃（engines 兼容约定）。
        console.log('DEGRADE  宿主缺少 @deepseek-ai/dsh-session-persistence-jsonl（' + jsonlPkgDir + '）');
        console.log('DEGRADE  该宿主版本（0.1.x–0.2.0 线）不含可独立加载的 JSONL 会话持久化组件，');
        console.log('DEGRADE  插件上下文写入的 v4 JSONL 落盘验证在本宿主上跳过；请改用 >=0.2.0-rc.1 宿主重跑。');
        console.log('DEGRADE  跳过不视为失败（显式降级，非崩溃）。');
        return;
    }
    // 宿主模块加载：与宿主进程同一物理模块实例（经宿主 node_modules 解析，杜绝双包冒险）。
    const hostRequire = createRequire(join(hostNodeModules, 'verify-anchor.js'));
    const importHost = async (name) => import(pathToFileURL(hostRequire.resolve(name)).href);
    const cordis = await importHost('@deepseek-ai/cordis');
    const { default: JsonlSessionPersistence } = await importHost('@deepseek-ai/dsh-session-persistence-jsonl');
    const sessionMod = await importHost('@deepseek-ai/dsh-session');
    const llm = await importHost('@deepseek-ai/dsh-llm');
    const { SESSION_FORMAT_VERSION } = sessionMod;
    if (SESSION_FORMAT_VERSION !== 4)
        throw new Error('宿主 SESSION_FORMAT_VERSION=' + String(SESSION_FORMAT_VERSION) + '，本脚本按 v4 编写');

    console.log('宿主: ' + host);
    console.log('加载: @deepseek-ai/cordis / dsh-session-persistence-jsonl / dsh-session(v' + String(SESSION_FORMAT_VERSION) + ') / dsh-llm');
    const root = await mkdtemp(join(tmpdir(), 'dsh-onebot-ctx-verify-'));
    console.log('临时会话目录: ' + root);
    try {
        await verify(root, cordis, JsonlSessionPersistence, llm, SESSION_FORMAT_VERSION);
    }
    finally {
        await cleanup(root);
    }
    const failed = results.filter(r => !r.pass);
    console.log('');
    console.log('结果: ' + String(results.length - failed.length) + '/' + String(results.length) + ' 场景 PASS' + (failed.length > 0 ? '（' + failed.map(r => r.id).join(', ') + ' FAIL）' : ' — ALL PASS'));
    if (failed.length > 0)
        process.exit(1);
}

async function verify(root, cordis, JsonlSessionPersistence, llm, formatVersion) {
    // 独立 cordis Context 装载宿主 JSONL 持久化插件（root 指向临时目录）。
    const ctx = new cordis.Context();
    ctx.plugin(JsonlSessionPersistence, { root });
    const persistence = await waitFor(() => {
        try {
            const service = ctx.sessionPersistence ?? ctx.get('sessionPersistence');
            return service?.create !== undefined ? service : undefined;
        }
        catch {
            return undefined;
        }
    }, '宿主 JSONL 会话持久化服务未就绪（ctx.sessionPersistence）');
    const headerOf = (id) => ({
        version: formatVersion,
        id,
        createdAt: Date.now(),
        cwd: process.cwd(),
        isSeeded: false,
    });
    // 与 lib/bridge.js:343/503 完全同形的消息构造（producer-owned source kind）。
    const pluginMessage = (text) => llm.createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: PLUGIN_SOURCE_KIND },
    });
    const surfaceEvent = (seq, type, data) => ({ type, seq, time: Date.now(), data, surfaceOp: 'append' });
    const plainEvent = (seq, type, data) => ({ type, seq, time: Date.now(), data });

    // ---- S1 普通消息：turn/start + QQ 入站正文 ----
    {
        const id = crypto.randomUUID();
        const handle = await persistence.create(headerOf(id));
        const text = '你好，来自 QQ 的普通消息';
        await handle.append([
            plainEvent(0, 'turn/start', { turn: 1 }),
            surfaceEvent(1, 'user/message', pluginMessage(text)),
        ]);
        await handle.flush();
        const { events } = await handle.read();
        const message = events.find(e => e.type === 'user/message')?.data;
        report('S1', '普通消息（followup，' + PLUGIN_SOURCE_KIND + '）', message !== undefined
            && message.source?.kind === PLUGIN_SOURCE_KIND
            && message.content?.[0]?.text === text
            && events.map(e => e.seq).join(',') === '0,1', message === undefined ? '未读到 user/message' : undefined);
        // 后续场景共用该会话（interim → 多段 → 关闭重读 → 下一轮）。
        // ---- S2 interim 中间消息（steer 通道，bridge.js:503 同形） ----
        const steerText = '[语音转写] 帮我看看今天的安排';
        await handle.append([surfaceEvent(2, 'user/message', pluginMessage(steerText))]);
        await handle.flush();
        const afterSteer = await handle.read();
        const steer = afterSteer.events.at(-1)?.data;
        report('S2', 'interim 中间消息（steer 同 kind）', steer?.source?.kind === PLUGIN_SOURCE_KIND
            && steer?.content?.[0]?.text === steerText
            && afterSteer.events.length === 3);
        // ---- S3 组合多段文本（媒体注释 + 正文） ----
        const mediaNote = '[图片] /tmp/dsh-onebot-verify/x.png';
        const body = '这张图里是什么？';
        const combined = llm.createUserMessage({
            content: [{ type: 'text', text: mediaNote }, { type: 'text', text: body }],
            source: { kind: PLUGIN_SOURCE_KIND },
        });
        await handle.append([surfaceEvent(3, 'user/message', combined)]);
        await handle.flush();
        const afterCombined = await handle.read();
        const blocks = afterCombined.events.at(-1)?.data?.content;
        report('S3', '组合多段文本（媒体注释+正文）', Array.isArray(blocks) && blocks.length === 2
            && blocks[0]?.text === mediaNote && blocks[1]?.text === body);
        // ---- S4 关闭后重读 ----
        await handle.close();
        const reader = await persistence.open(id, 'read');
        const reread = await reader.read();
        const kinds = reread.events.map(e => e.type).join(',');
        report('S4', '关闭后重读（write close → read open）', reread.events.length === 4
            && kinds === 'turn/start,user/message,user/message,user/message'
            && reread.events.every(e => e.type !== 'user/message' || e.data.source?.kind === PLUGIN_SOURCE_KIND), 'seqs=' + reread.events.map(e => e.seq).join(','));
        await reader.close();
        // ---- S5 继续写入下一轮 ----
        const writer = await persistence.open(id, 'write');
        const round2 = '第二轮：继续对话';
        await writer.append([
            plainEvent(4, 'turn/end', { turn: 1, reason: 'completed' }),
            plainEvent(5, 'turn/start', { turn: 2 }),
            surfaceEvent(6, 'user/message', pluginMessage(round2)),
        ]);
        await writer.flush();
        await writer.close();
        const reader2 = await persistence.open(id, 'read');
        const final = await reader2.read();
        const last = final.events.at(-1)?.data;
        report('S5', '继续写入下一轮（write 重开→turn 2→再读回）', final.events.length === 7
            && last?.source?.kind === PLUGIN_SOURCE_KIND && last?.content?.[0]?.text === round2, 'seqs=' + final.events.map(e => e.seq).join(','));
        await reader2.close();
    }
    // ---- S6 负向回归：retired kind `plugin` 必须被 v4 admission 拒绝 ----
    {
        const id = crypto.randomUUID();
        const handle = await persistence.create(headerOf(id));
        const retired = llm.createUserMessage({
            content: [{ type: 'text', text: 'retired source kind' }],
            source: { kind: 'plugin' },
        });
        let rejected = null;
        try {
            await handle.append([surfaceEvent(0, 'user/message', retired)]);
            await handle.flush();
            await handle.read();
        }
        catch (error) {
            rejected = error;
        }
        const ok = rejected !== null && /producer-owned source kind/.test(String(rejected?.message ?? ''))
            && rejected?.name === 'SessionFormatError';
        report('S6', '负向：retired kind "plugin" 被 v4 admission 拒绝', ok, ok ? 'SessionFormatError: ' + rejected.message : rejected === null ? '未被拒绝（回归！）' : '异常类型不符: ' + rejected?.constructor?.name + ' ' + rejected?.message);
        try {
            await handle.close();
        }
        catch {
            // 已被 admission 失败污染的会话句柄：关闭失败不视为场景失败。
        }
    }
}

async function waitFor(fn, message, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = fn();
        if (value !== undefined)
            return value;
        if (Date.now() > deadline)
            throw new Error(message + '（等待超时 ' + String(timeoutMs) + 'ms）');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

async function cleanup(root) {
    await rm(root, { recursive: true, force: true });
    const gone = await stat(root).then(() => false, error => error?.code === 'ENOENT');
    console.log('');
    console.log('清理确认: 临时会话目录 ' + root + (gone ? ' 已删除（自验 ENOENT）' : ' 仍存在（FAIL）'));
    if (!gone) {
        results.push({ id: 'CL', name: '临时目录自清理', pass: false });
        process.exitCode = 1;
    }
    else {
        results.push({ id: 'CL', name: '临时目录自清理', pass: true });
    }
}

main().catch(error => {
    console.error('verify-injected-context 运行失败: ' + (error instanceof Error ? error.stack : String(error)));
    process.exit(1);
});
