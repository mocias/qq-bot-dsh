#!/usr/bin/env node
/**
 * dsh-onebot 集成验证 ②：LAN 管理面读写回链路（仿 dsh-im verify-lan-management
 * 模式）。
 *
 * 用法：node scripts/verify-lan-management.mjs <宿主构建路径>
 *   例：node scripts/verify-lan-management.mjs /vol2/@appdata/Harness/server/0.2.1-alpha.2
 *
 * 用原版 dsh CLI + 独立临时 profile（DSH_HOME 指向 mktemp 目录）启动真实宿主，
 * 把本仓库构建产物（lib/）挂进临时 profile（设置页 onebotSettings Typert
 * Remote），走真实 /api 通道做管理面集成测试：
 *   S1 未认证访问 → 401（浏览器认证在位）
 *   S2 伪造 Host（DNS rebinding fence）→ 403
 *   S3 伪造 Origin → 403
 *   S4 启动链接 token 换浏览器 cookie（GET /?token=… → 303 + set-cookie）
 *   S5 认证后 getSettings 读回快照（revision 0、entryActive true、配置生效值）
 *   S6 updateSettings 写入 → revision+1，快照值落盘到临时 profile patch 文件
 *   S7 过期 expectedRevision 重放 → onebot-settings/conflict（乐观锁）
 *   S8 重读确认持久化值 + 恢复原值（回链路闭合，patch 文件复原）
 *
 * 安全铁律：
 * - 只管理本脚本自己 spawn 的宿主子进程：记录 PID，SIGTERM/SIGKILL 只打该 PID，
 *   禁止 pkill 类模糊匹配；退出前 ps 自验无残留子进程；
 * - 临时 profile 全部在 mktemp 目录，不触碰 ~/.dsh 生产 profile；
 * - Web 端口与插件 reverse WS 端口均为运行时探测的非常规空闲高位端口，
 *   不占用生产端口。
 *
 * 行为契约：
 * - 结束停服务并清理临时目录（自验 ENOENT + 端口释放 + 无残留 PID）；
 * - 无需机器人凭据、无 NapCat 连接（reverse 模式只监听，不外呼）；
 * - 宿主路径缺失/非法 → usage 报错 exit 1（不静默）；
 * - 宿主/部署环境 API 缺失（旧宿主无 /api RPC 或插件 peer 包缺失等）→ 输出
 *   显式 DEGRADE 说明后 exit 0（不崩溃，engines 兼容 0.1.5–0.2.0 线）；
 * - 不进 vitest、不阻塞 CI；本脚本为 build 产物消费方，不改仓库文件。
 * @module dsh-onebot/verify-lan-management
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm, stat, symlink, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import http from 'node:http';

const PLUGIN_ROOT = resolve(new URL('..', import.meta.url).pathname);
const PLUGIN_PORT_KEY = 'sendErrorNotice';

function usage(message) {
    console.error('用法: node scripts/verify-lan-management.mjs <宿主构建路径>');
    console.error('  <宿主构建路径>: 已安装 dsh 的宿主目录（其下应有 node_modules/.bin/dsh），');
    console.error('  例: /vol2/@appdata/Harness/server/0.2.1-alpha.2');
    if (message !== undefined)
        console.error('错误: ' + message);
    process.exit(1);
}

const results = [];
function report(id, name, pass, detail) {
    results.push({ id, name, pass });
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + id + ' ' + name + (detail !== undefined ? ' — ' + detail : ''));
}
function degrade(lines) {
    for (const line of lines)
        console.log('DEGRADE  ' + line);
    console.log('DEGRADE  跳过不视为失败（显式降级，非崩溃）。');
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
    const dshBin = join(host, 'node_modules', '.bin', 'dsh');
    if (!existsSync(dshBin)) {
        if (!existsSync(join(host, 'node_modules', '@deepseek-ai')))
            usage('路径下没有 node_modules/@deepseek-ai/，不是 dsh 宿主安装目录: ' + host);
        degrade([
            '宿主缺少 ' + dshBin + '，无法以原版 dsh CLI 启动真实宿主。',
            'LAN 管理面集成测试在本宿主上跳过；请改用带 dsh CLI 的宿主重跑。',
        ]);
        return;
    }
    if (!existsSync(join(PLUGIN_ROOT, 'lib', 'index.js'))) {
        degrade([
            '仓库缺少构建产物 lib/（先运行 npm run build 生成），无法挂载插件。',
            'LAN 管理面集成测试跳过；本脚本为 build 产物消费方。',
        ]);
        return;
    }
    const webPort = await freePort();
    const wsPort = await freePort();
    console.log('宿主: ' + host);
    console.log('端口（运行时探测的空闲高位端口）: web=' + String(webPort) + ', onebot-reverse-ws=' + String(wsPort));
    const work = await mkdtemp(join(tmpdir(), 'dsh-onebot-lan-verify-'));
    const home = join(work, 'home');
    const deploy = join(work, 'plugin');
    const logFile = join(work, 'host.log');
    console.log('临时目录: ' + work + '（DSH_HOME=' + home + '）');
    let child = null;
    let logHandle = null;
    try {
        await prepareDeployment(deploy, host);
        await writeProfilePatch(home, deploy, wsPort, work);
        // 宿主输出 tee 到日志文件（轮询就绪行 + 失败诊断），绝不留未消费的管道。
        const { open } = await import('node:fs/promises');
        logHandle = await open(logFile, 'w');
        child = spawn(dshBin, ['web', '--no-open', '--port', String(webPort)], {
            env: { ...process.env, DSH_HOME: home },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        for (const stream of [child.stdout, child.stderr]) {
            stream.on('data', chunk => {
                logHandle?.appendFile(chunk).catch(() => {
                    // 句柄已关闭后的残余输出：忽略（进程即将结束）。
                });
            });
            stream.resume();
        }
        console.log('已启动宿主子进程 pid=' + String(child.pid) + '（退出前只对记录的 PID 停止）');
        const output = await waitReady(child, logFile, webPort);
        const token = /dsh web: \S*token=([A-Za-z0-9_-]+)/.exec(output)?.[1];
        if (token === undefined)
            throw new Error('宿主启动成功但未从输出解析到登录 token（dsh web: …token=…）');
        await runScenarios(webPort, token, home);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/DEGRADE:/.test(message)) {
            degrade(message.replace(/DEGRADE:\s*/g, '').split('\n'));
        }
        else {
            console.error('FAIL  运行失败: ' + message);
            results.push({ id: 'RUN', name: '脚本运行', pass: false });
            try {
                const tail = (await readFile(logFile, 'utf8')).split('\n').slice(-15).join('\n');
                console.error('宿主日志尾部:\n' + tail);
            }
            catch {
                // 无日志可读
            }
        }
    }
    finally {
        await teardown(child, work, webPort, wsPort, logHandle);
    }
    const failed = results.filter(r => !r.pass);
    console.log('');
    if (results.length === 0)
        console.log('结果: 无场景执行（已降级跳过）');
    else
        console.log('结果: ' + String(results.length - failed.length) + '/' + String(results.length) + ' 场景 PASS' + (failed.length > 0 ? '（' + failed.map(r => r.id).join(', ') + ' FAIL）' : ' — ALL PASS'));
    if (failed.length > 0)
        process.exit(1);
}

/** 临时部署副本：lib/ 产物 + 指向指定宿主的 peer 链接集（link-host.sh 语义，
 * 全部落在 mktemp 目录内，不触碰仓库与主检出 node_modules）。 */
async function prepareDeployment(deploy, host) {
    await cp(join(PLUGIN_ROOT, 'lib'), join(deploy, 'lib'), { recursive: true });
    await cp(join(PLUGIN_ROOT, 'package.json'), join(deploy, 'package.json'));
    await cp(join(PLUGIN_ROOT, 'dsh.plugin.json'), join(deploy, 'dsh.plugin.json'));
    const hostNm = join(host, 'node_modules');
    const linked = [];
    const missing = [];
    for (const pkg of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/schemastery']) {
        const target = join(hostNm, ...pkg.split('/'));
        if (existsSync(target)) {
            await linkInto(deploy, pkg, target);
            linked.push(pkg);
        }
        else {
            missing.push(pkg);
        }
    }
    if (existsSync(join(hostNm, 'ws'))) {
        await linkInto(deploy, 'ws', join(hostNm, 'ws'));
        linked.push('ws');
    }
    // 渲染依赖（@napi-rs/canvas、fontkit）从本仓库自身 node_modules 解析（真实目录）。
    const repoRequire = createRequire(join(PLUGIN_ROOT, 'package.json'));
    for (const pkg of ['@napi-rs/canvas', 'fontkit']) {
        try {
            // exports 字段可能不暴露 ./package.json，故解析包入口文件再回溯包根目录。
            const entry = repoRequire.resolve(pkg);
            let dir = entry.replace(/\/[^/]*$/, '');
            while (dir !== '/' && !existsSync(join(dir, 'package.json')))
                dir = dir.replace(/\/[^/]*$/, '');
            if (dir === '/')
                throw new Error('无法定位 ' + pkg + ' 包根目录');
            await linkInto(deploy, pkg, dir);
            linked.push(pkg);
        }
        catch {
            missing.push(pkg);
        }
    }
    if (missing.length > 0) {
        // 关键 peer（无则插件无法挂载）→ 显式降级；canvas/fontkit 缺失同样阻断挂载。
        throw new Error('DEGRADE: 临时部署副本缺以下依赖链接（插件无法挂载，管理面测试跳过）:\n' +
            missing.map(pkg => 'DEGRADE:   - ' + pkg).join('\n') +
            '\nDEGRADE: 已链接: ' + linked.join(', '));
    }
    console.log('临时部署副本: ' + deploy + '（peer 链接 → 宿主/仓库: ' + linked.join(', ') + '）');
}

async function linkInto(deploy, name, target) {
    const parts = name.split('/');
    const dir = join(deploy, 'node_modules', ...parts.slice(0, -1));
    await mkdir(dir, { recursive: true });
    await symlink(target, join(dir, parts.at(-1)));
}

/** 临时 profile 层挂载：insert 行只写 id+name；config 必须挂 patch 文档顶层
 * 同 id 行（insert 块内 config 会被 configEditor compose 自检拒绝写入）。 */
async function writeProfilePatch(home, deploy, wsPort, work) {
    const profileDir = join(home, 'profiles', 'web');
    await mkdir(profileDir, { recursive: true });
    const entryName = 'file://' + join(deploy, 'lib', 'index.js');
    const remoteName = 'file://' + join(deploy, 'lib', 'settings-remote.js');
    const patch = [
        '# verify-lan-management 临时 profile（脚本生成，用后即删）',
        '- insert:',
        '  - id: dsh-onebot',
        '    name: ' + entryName,
        '  - id: onebot-settings-remote',
        '    name: ' + remoteName,
        '- id: dsh-onebot',
        '  config:',
        '    mode: reverse',
        '    host: 127.0.0.1',
        '    port: ' + String(wsPort),
        "    accessToken: verify-lan-token",
        "    botQQ: ''",
        '    workspacePath: ' + join(work, 'workspace'),
        '',
    ].join('\n');
    await writeFile(join(profileDir, 'cordis.patch.yml'), patch, 'utf8');
}

async function waitReady(child, logFile, webPort) {
    const deadline = Date.now() + 120_000;
    let exitedInfo = null;
    const onExit = (code, signal) => {
        exitedInfo = { code, signal };
    };
    child.once('exit', onExit);
    let acc = '';
    try {
        while (exitedInfo === null) {
            acc += await readNew(logFile);
            if (acc.includes('dsh web:'))
                return acc;
            if (Date.now() > deadline)
                throw new Error('等待宿主就绪超时（120s）；日志尾部:\n' + acc.split('\n').slice(-15).join('\n'));
            await sleep(500);
        }
        throw new Error('宿主子进程提前退出 code=' + String(exitedInfo.code) + ' signal=' + String(exitedInfo.signal)
            + '；日志:\n' + (acc || (await readFile(logFile, 'utf8').catch(() => ''))).split('\n').slice(-25).join('\n'));
    }
    finally {
        child.off('exit', onExit);
    }
}

async function runScenarios(webPort, token, home) {
    const base = { host: '127.0.0.1', port: webPort };
    const rpc = (endpoint, args, headers = {}) => postJson(base, '/api/' + endpoint, {
        type: 'client-request',
        rpcId: 'verify-' + String(++rpcSeq),
        method: endpoint,
        payload: { args },
    }, headers);
    let rpcSeq = 0;
    // S1 未认证 → 401
    const unauth = await rpc('onebotSettings/getSettings', {});
    report('S1', '未认证 /api 访问被拒', unauth.status === 401, 'status=' + String(unauth.status));
    // S4 token 换 cookie（先于 S2/S3：fence 检查与认证独立）
    const mint = await exchangeToken(base, token);
    report('S4', '启动链接 token 换浏览器 cookie', mint.status === 303 && mint.cookie !== undefined, 'status=' + String(mint.status));
    const cookieHeader = mint.cookie !== undefined ? { cookie: mint.cookie } : {};
    // S2 伪造 Host → 403（DNS rebinding fence；node fetch 禁改 Host，用原生 http）
    const evilHost = await rpc('onebotSettings/getSettings', {}, { ...cookieHeader, host: 'evil.example' });
    report('S2', '伪造 Host 被 fence 拒绝', evilHost.status === 403, 'status=' + String(evilHost.status));
    // S3 伪造 Origin → 403
    const evilOrigin = await rpc('onebotSettings/getSettings', {}, { ...cookieHeader, origin: 'http://evil.example:99' });
    report('S3', '伪造 Origin 被 fence 拒绝', evilOrigin.status === 403, 'status=' + String(evilOrigin.status));
    // S5 认证后读快照
    const read1 = await rpc('onebotSettings/getSettings', {}, cookieHeader);
    const snapshot = read1.body?.type === 'server-response' && read1.body.result?.ok === true ? read1.body.result.value : undefined;
    report('S5', '认证后 getSettings 读回快照', read1.status === 200 && snapshot !== undefined
        && snapshot.revision === 0 && snapshot.entryActive === true
        && snapshot.config?.mode === 'reverse'
        && snapshot.config?.accessToken === '', snapshot === undefined
        ? 'status=' + String(read1.status) + ' body=' + JSON.stringify(read1.body).slice(0, 200)
        : 'revision=' + String(snapshot.revision) + ' entryActive=' + String(snapshot.entryActive));
    if (snapshot === undefined)
        throw new Error('DEGRADE: onebotSettings/getSettings 未返回可用快照（旧宿主无 Typert Remote 网关或插件未挂载），管理面读写回链路无法验证');
    const revision0 = snapshot.revision;
    // S6 写入 → revision+1 + patch 文件落盘
    const write = await rpc('onebotSettings/updateSettings', { patch: { [PLUGIN_PORT_KEY]: false }, expectedRevision: revision0 }, cookieHeader);
    const written = write.body?.result;
    const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml');
    const patchAfterWrite = await readFile(patchPath, 'utf8');
    report('S6', 'updateSettings 写入（' + PLUGIN_PORT_KEY + '=false）', written?.ok === true
        && written?.value?.revision === revision0 + 1
        && written?.value?.config?.[PLUGIN_PORT_KEY] === false
        && patchAfterWrite.includes(PLUGIN_PORT_KEY + ': false'), written?.ok === true
        ? 'revision ' + String(revision0) + ' → ' + String(written?.value?.revision)
        : 'error=' + JSON.stringify(written?.error).slice(0, 200));
    // S7 过期 expectedRevision 重放 → 乐观锁冲突
    const stale = await rpc('onebotSettings/updateSettings', { patch: { [PLUGIN_PORT_KEY]: true }, expectedRevision: revision0 }, cookieHeader);
    report('S7', '过期 expectedRevision 被乐观锁拒绝', stale.body?.result?.ok === false
        && stale.body?.result?.error?.code === 'onebot-settings/conflict', 'code=' + String(stale.body?.result?.error?.code));
    // S8 重读持久化值 + 恢复
    const read2 = await rpc('onebotSettings/getSettings', {}, cookieHeader);
    const persisted = read2.body?.result?.value?.config?.[PLUGIN_PORT_KEY] === false
        && read2.body?.result?.value?.revision === revision0 + 1;
    const restore = await rpc('onebotSettings/updateSettings', { patch: { [PLUGIN_PORT_KEY]: true }, expectedRevision: revision0 + 1 }, cookieHeader);
    const restoredPatch = await readFile(patchPath, 'utf8');
    report('S8', '重读确认持久化 + 恢复原值（回链路闭合）', persisted
        && restore.body?.result?.ok === true
        && restore.body?.result?.value?.config?.[PLUGIN_PORT_KEY] === true
        && !restoredPatch.includes(PLUGIN_PORT_KEY + ': false'), persisted && restore.body?.result?.ok === true
        ? '快照与临时 patch 文件均已复原'
        : 'persisted=' + String(persisted) + ' restore=' + String(restore.body?.result?.ok));
}

// ---------------------------------------------------------------- HTTP 原生层
let rpcSeq = 0;

function postJson(base, path, body, headers) {
    return new Promise((resolvePromise, rejectPromise) => {
        const payload = JSON.stringify(body);
        const req = http.request({
            ...base,
            path,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
                ...headers,
            },
            timeout: 10_000,
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let parsed;
                try {
                    parsed = JSON.parse(text);
                }
                catch {
                    parsed = undefined;
                }
                resolvePromise({ status: res.statusCode ?? 0, body: parsed, setCookie: res.headers['set-cookie'] });
            });
        });
        req.on('error', rejectPromise);
        req.on('timeout', () => {
            req.destroy(new Error('请求超时: ' + path));
        });
        req.end(payload);
    });
}

/** GET /?token=… → 303 + set-cookie（浏览器认证 cookie 铸造）。 */
function exchangeToken(base, token) {
    return new Promise((resolvePromise, rejectPromise) => {
        const req = http.get({ ...base, path: '/?token=' + encodeURIComponent(token), timeout: 10_000 }, res => {
            res.resume();
            const cookie = res.headers['set-cookie']?.[0]?.split(';')[0];
            resolvePromise({ status: res.statusCode ?? 0, cookie });
        });
        req.on('error', rejectPromise);
        req.on('timeout', () => {
            req.destroy(new Error('token 交换超时'));
        });
    });
}

// ---------------------------------------------------------------- 端口/进程/清理
async function freePort() {
    return await new Promise((resolvePromise, rejectPromise) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address !== null ? address.port : 0;
            server.close(() => (port > 0 ? resolvePromise(port) : rejectPromise(new Error('无法探测空闲端口'))));
        });
        server.on('error', rejectPromise);
    });
}

async function teardown(child, work, webPort, wsPort, logHandle) {
    console.log('');
    if (child !== null && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const pid = child.pid;
        console.log('停止宿主子进程: pid=' + String(pid) + '（仅此 PID，不做模糊匹配）');
        child.kill('SIGTERM');
        const exited = await Promise.race([
            new Promise(resolve => child.once('exit', () => resolve(true))),
            new Promise(resolve => setTimeout(() => resolve(false), 10_000)),
        ]);
        if (!exited) {
            console.log('SIGTERM 10s 未退出，升级 SIGKILL: pid=' + String(pid));
            child.kill('SIGKILL');
            await new Promise(resolve => child.once('exit', resolve));
        }
        results.push({ id: 'STOP', name: '宿主子进程已停止（记录 PID）', pass: true });
    }
    else if (child !== null) {
        console.log('宿主子进程已在脚本内退出（code=' + String(child.exitCode) + '）');
    }
    try {
        await logHandle?.close();
    }
    catch {
        // 已关闭
    }
    await sleep(500);
    // 无残留子进程自验：仅核对记录的 PID，不做 pkill 类模糊匹配。
    if (child?.pid !== undefined) {
        const alive = await pidAlive(child.pid);
        report('PID', '无残留宿主子进程（pid=' + String(child.pid) + '）', !alive);
    }
    const webFreed = await portClosed(webPort);
    const wsFreed = await portClosed(wsPort);
    report('PORT', '端口已释放（web/onebot-ws）', webFreed && wsFreed, 'web=' + String(webPort) + (webFreed ? ' closed' : ' STILL-OPEN') + ', ws=' + String(wsPort) + (wsFreed ? ' closed' : ' STILL-OPEN'));
    await rm(work, { recursive: true, force: true });
    const { stat: statFn } = await import('node:fs/promises');
    const gone = await statFn(work).then(() => false, error => error?.code === 'ENOENT');
    report('CLEAN', '临时目录自清理（' + work + '）', gone, gone ? '自验 ENOENT' : '仍存在');
}

async function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}

async function portClosed(port) {
    // 绑定成功 = 端口已释放（true）；绑定失败 = 端口仍被占用（false）。
    return await new Promise(resolve => {
        const server = createServer();
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => {
            server.close(() => resolve(true));
        });
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let logOffset = 0;
async function readNew(file) {
    try {
        const text = await readFile(file, 'utf8');
        const fresh = text.slice(logOffset);
        logOffset = text.length;
        return fresh;
    }
    catch {
        return '';
    }
}

main().catch(error => {
    console.error('verify-lan-management 运行失败: ' + (error instanceof Error ? error.stack : String(error)));
    process.exit(1);
});
