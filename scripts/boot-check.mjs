#!/usr/bin/env node
/**
 * boot-check.mjs — 真正启动一次 profile，验证它「能装配、能服务、无报错」。
 *
 * 为什么必须有这一步（2026-10-19 实测）：
 *   `dsh --profile web --dump-config` 只会【组合】 YAML，并不解析模块。所以：
 *
 *     注入一条 `- insert: - id: ghost, name: '@deepseek-ai/dsh-nonexistent-module'`
 *       dump-config : exit 0，stderr **0 行**，那条 row 照常出现在输出里  ← 完全看不见
 *       真实启动     : ✗ ghost (@deepseek-ai/...): failed to import: ERR_MODULE_NOT_FOUND  ← 抓到
 *
 *   结论：dump-config 的 stderr 断言是【必要但不充分】的。装配阶段的失败
 *   （模块解析不了、插件 apply 抛错、服务注册冲突）只有真正启动才看得见。
 *
 * 判据（三项缺一不可）：
 *   1. 进程存活且端口进入监听
 *   2. HTTP 层拿到带 __DSH_BOOT__ 的页面（证明 SPA 真的装配了，不是只有端口在听）
 *   3. stderr 里没有真实错误
 *
 * 已知良性输出单独分类并说明理由 —— 不静默白名单。
 *
 * 用法：
 *   node scripts/boot-check.mjs                     # 默认 --profile web
 *   node scripts/boot-check.mjs --profile tpltest
 *   node scripts/boot-check.mjs --timeout 180 --json
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer, Socket } from 'node:net';

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PROFILE = argOf('profile', 'web');
const TIMEOUT_S = Number(argOf('timeout', '180'));
const DSH = argOf('dsh', 'dsh');     // 允许指定宿主可执行文件（测试/CI 用）
const AS_JSON = argv.includes('--json');

/** 让操作系统给一个空闲端口，避免撞上正在跑的那个实例。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const tryConnect = (port) => new Promise((resolve) => {
  const sock = new Socket();
  sock.setTimeout(1200);
  sock.once('connect', () => { sock.destroy(); resolve(true); });
  sock.once('timeout', () => { sock.destroy(); resolve(false); });
  sock.once('error', () => resolve(false));
  sock.connect(port, '127.0.0.1');
});

const PORT = await freePort();
const started = Date.now();

// --no-open：不要弹浏览器。--port：固定到我们挑的空闲端口。
// detached 在 POSIX 上是为了得到【独立进程组】，否则 process.kill(-pid) 抛 ESRCH，
// 启动的服务会留在后台占着端口。Windows 走 taskkill /T，不需要 detached。
//
// Windows 上 npm 装的 dsh 是 .cmd 垫片，不经 shell 就执行不了。但【不能】把 args 数组
// 和 shell:true 一起传 —— Node 会报 DEP0190（参数不转义，存在注入风险），而且这条警告
// 会混进 stderr 污染的判定输出（本仓库实测：汇总行显示成了这条警告）。
// 所以 Windows 下自己拼一条命令行、显式加引号，只传字符串；POSIX 下仍然数组直传。
const dshArgs = ['--profile', PROFILE, '--no-open', '--port', String(PORT)];
const quoteForShell = (s) => (/[\s"]/.test(String(s)) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));
const child = process.platform === 'win32'
  ? spawn([DSH, ...dshArgs].map(quoteForShell).join(' '), {
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  : spawn(DSH, dshArgs, {
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

let stdout = '', stderr = '';
child.stdout.on('data', (c) => { stdout += c; });
child.stderr.on('data', (c) => { stderr += c; });

let listened = false;
while (Date.now() - started < TIMEOUT_S * 1000) {
  await new Promise((r) => setTimeout(r, 1500));
  if (await tryConnect(PORT)) { listened = true; break; }
  if (child.exitCode !== null) break;
}

// 带 token 的地址是在监听【之后】才打印的，且间隔不固定 → 必须轮询，不能固定等待。
if (listened) {
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !/[?&]token=/.test(stdout) && child.exitCode === null) {
    await new Promise((r) => setTimeout(r, 250));
  }
}

let page = { status: null, boots: false, bytes: 0, title: null };
const token = (stdout.match(/[?&]token=([^\s"'&<>]+)/) ?? [])[1];
if (listened && token) {
  try {
    const r1 = await fetch(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    const cookie = (r1.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
      || (r1.headers.get('set-cookie') ?? '').split(';')[0];
    const loc = r1.headers.get('location');
    const url2 = loc ? new URL(loc, `http://127.0.0.1:${PORT}/`).toString() : `http://127.0.0.1:${PORT}/`;
    const r2 = await fetch(url2, { headers: cookie ? { cookie } : {}, redirect: 'follow' });
    const body = await r2.text().catch(() => '');
    page = {
      status: r2.status,
      boots: body.includes('__DSH_BOOT__'),
      bytes: body.length,
      title: (body.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? null,
    };
  } catch (e) {
    page.error = String(e.message).slice(0, 120);
  }
}

const alive = child.exitCode === null;

// 带理由的良性分类器 —— 不是静默白名单。
const BENIGN = [
  {
    test: /task-board ledger is already owned by process (\d+)/,
    why: (m) => `task-board 单实例锁被进程 ${m[1]} 持有（同一台机器上还有另一个 dsh 在跑）。插件按设计优雅降级。`,
  },
  {
    test: /\[dsh-web-all\] plugin degraded \(start\): @linxin666\/dsh-client-ui-task-board/,
    why: () => '上一条锁冲突的连带日志，同一根因。',
  },
  {
    test: /corpus-mcp \d+\.\d+\.\d+ /,
    why: () => 'MCP 服务器的启动横幅，走 stderr 是它的正常行为。',
  },
];
const rawErrors = stderr.split(/\r?\n/).filter(Boolean)
  .filter((l) => /error|failed|cannot|unable|TypeError|ReferenceError|ERR_|rejected|incompatible/i.test(l));
const classified = rawErrors.map((line) => {
  for (const b of BENIGN) {
    const m = b.test.exec(line);
    if (m) return { line, benign: true, why: b.why(m) };
  }
  return { line, benign: false };
});
const realErrors = classified.filter((c) => !c.benign);
const benignErrors = classified.filter((c) => c.benign);

const pass = alive && listened && realErrors.length === 0 && page.boots === true;
const result = {
  profile: PROFILE,
  port: PORT,
  alive,
  listened,
  elapsedSeconds: Math.round((Date.now() - started) / 1000),
  http: page,
  realErrors: realErrors.map((e) => e.line),
  benignErrors: [...new Set(benignErrors.map((e) => e.why))],
  pass,
};

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`profile: ${PROFILE}   端口: ${PORT}`);
  console.log(`  进程存活   ${alive}`);
  console.log(`  端口监听   ${listened}`);
  console.log(`  启动耗时   ${result.elapsedSeconds}s`);
  console.log(`  HTTP       ${page.status ?? '未探测'}${page.bytes ? `  ${page.bytes} 字节` : ''}${page.boots ? '  含 __DSH_BOOT__ ✓' : '  ✗ 没有 __DSH_BOOT__'}`);
  if (page.title) console.log(`  <title>    ${page.title}`);
  if (page.error) console.log(`  取页失败   ${page.error}`);
  console.log(`  真错误     ${realErrors.length} 条`);
  for (const e of realErrors.slice(0, 10)) console.log(`    ✗ ${e.line.slice(0, 200)}`);
  if (benignErrors.length) {
    console.log(`  已分类良性 ${benignErrors.length} 条（不当失败处理）`);
    for (const w of result.benignErrors) console.log(`    · ${w}`);
  }
  console.log(`\n判定: ${pass ? 'PASS —— 装配、服务、无报错三项都成立' : 'FAIL'}`);
  if (!pass && !page.boots && listened) console.log('  端口在听但没拿到 __DSH_BOOT__ —— 只证明服务器起来了，没证明装配成功。');
}

// 只杀自己起的这棵树。
try {
  if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  else process.kill(-child.pid, 'SIGKILL');
} catch { /* 可能已自行退出 */ }

process.exit(pass ? 0 : 1);
