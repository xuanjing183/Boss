/*
 * 真实 PDF 解析测试（三种 CSP 场景）：
 *   1) 用 headless Edge 把 test/resume-fixture.html 打印成中文 PDF（内嵌字体 + ToUnicode）
 *   2) 从 .user.js 里切出 PDF-BEGIN/END 之间的生产代码，原样注入测试页
 *   3) 三个 CSP 场景，分别逼出三条 worker 路线：
 *        pdf-main.html   —— 放开 unsafe-eval、worker-src 'none'
 *                           → 路线 1「主线程 fake worker」，等价于油猴沙箱，最稳，硬断言成功
 *        pdf-blob.html   —— 禁 eval、只放行 blob worker（站点没白名单镜像域名）
 *                           → 路线 2「同源 blob workerSrc」，断言机制搭对了 + 结论明确
 *        pdf-remote.html —— 禁 eval、worker-src 'none'、但 script-src 白名单了镜像
 *                           → 路线 3「远程 worker」，断言它不静默挂死、错误信息可行动
 *      注意：pdf-main 是硬断言（实测 458 字 / 5ms）。另外两个场景里 pdf.js 的真 worker
 *      传输层在 headless + file://（opaque origin）+ --virtual-time-budget 下不可复现，
 *      所以只断言「降级路径选对了、有明确结论、给了 .txt 兜底」，不断言抽取成功。
 * 用法：node test/build-pdf.js   （或 node test/run.js 一起跑）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const fixtureHtml = path.join(root, 'test', 'resume-fixture.html');
const fixturePdf = path.join(root, 'test', 'resume-fixture.pdf');
const PDFJS = 'https://registry.npmmirror.com/pdfjs-dist/3.11.174/files/legacy/build/pdf.min.js';
const WORKER = 'https://registry.npmmirror.com/pdfjs-dist/3.11.174/files/legacy/build/pdf.worker.min.js';

function findBrowser() {
  const c = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'];
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Edge/Chrome');
}

function ensurePdf() {
  const fresh = fs.existsSync(fixturePdf) && fs.statSync(fixturePdf).mtimeMs > fs.statSync(fixtureHtml).mtimeMs;
  if (fresh) return;
  const profile = path.join(os.tmpdir(), 'bg-edge-pdf');
  fs.mkdirSync(profile, { recursive: true });
  execFileSync(findBrowser(), [
    '--headless=new', '--disable-gpu', '--user-data-dir=' + profile,
    '--no-pdf-header-footer', '--virtual-time-budget=5000',
    '--print-to-pdf=' + fixturePdf, 'file:///' + fixtureHtml.replace(/\\/g, '/')
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  if (!fs.existsSync(fixturePdf) || fs.statSync(fixturePdf).size < 800) throw new Error('生成测试 PDF 失败');
}

const src = fs.readFileSync(path.join(root, 'boss-zhipin-llm-greet.user.js'), 'utf8');
const m = src.match(/\/\* PDF-BEGIN[\s\S]*?\*\/\n([\s\S]*?)\/\* PDF-END \*\//);
if (!m) { console.error('没找到 PDF-BEGIN / PDF-END 标记'); process.exit(1); }
const code = m[1].replace(/<\/script>/gi, '<\\/script>');

ensurePdf();
const b64 = fs.readFileSync(fixturePdf).toString('base64');

const SCENARIOS = [
  {
    key: 'main',
    title: 'CSP 禁 worker、允许 eval（等价于油猴沙箱）',
    csp: "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' " + PDFJS +
      "; worker-src 'none'; connect-src https://registry.npmmirror.com; style-src 'unsafe-inline'",
    timeoutMs: 20000,
    // 硬断言：路线 1 必须成功
    expectRoute: '主线程 fake worker'
  },
  {
    key: 'blob',
    title: 'CSP 禁 eval、只放行 blob worker，且没白名单镜像域名（严格站点）',
    csp: "default-src 'none'; script-src 'self' 'unsafe-inline' " + PDFJS +
      "; worker-src 'self' blob:; connect-src https://registry.npmmirror.com; style-src 'unsafe-inline'",
    timeoutMs: 12000,
    // 期望：路线 1 被拦 → 走「同源 blob」，且真的造出了带 JS MIME 的 blob worker 源码
    expectAttempt: '同源 blob',
    expectBlob: true
  },
  {
    key: 'remote',
    title: 'CSP 禁 eval、禁 worker，但 script-src 白名单了镜像（只剩远程路线）',
    csp: "default-src 'none'; script-src 'self' 'unsafe-inline' " + PDFJS + ' ' + WORKER +
      "; worker-src 'none'; connect-src https://registry.npmmirror.com; style-src 'unsafe-inline'",
    timeoutMs: 8000,
    // 期望：一路退到「站点远程 worker」，无论成败都要给可行动的错误 + .txt 兜底
    expectAttempt: '站点远程 worker'
  }
];

function page(s) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${s.csp}">
<title>PDF 解析测试 · ${s.key}</title>
<style>
body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:22px;color:#222}
.pass{color:#1c8a45;font-weight:600}.fail{color:#c8402f;font-weight:600}
.extra{color:#7a8698;font-size:12px;word-break:break-all}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #eee;padding:5px 8px;text-align:left;vertical-align:top}
#sum{font-size:16px;margin:8px 0}pre{background:#f7f9fc;border:1px solid #e6ebf2;padding:8px;max-height:220px;overflow:auto;font-size:12px;white-space:pre-wrap}
</style></head><body>
<h3>真实中文 PDF · 解析测试 —— ${s.title}</h3>
<div id="sum">运行中…</div>
<table><thead><tr><th style="width:36%">断言</th><th style="width:8%">结果</th><th>实际值</th></tr></thead><tbody id="rows"></tbody></table>
<h4>抽取到的文本</h4><pre id="txt"></pre>
<h4>降级过程</h4><pre id="lgs"></pre>
<script>window.__B64 = "${b64}";<\/script>
<script src="${PDFJS}"><\/script>
<script>
var LOGS = [];
function log(m) { LOGS.push(m); }
var __blobs = [];
(function () {
  var oc = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (b) { __blobs.push({ type: String((b && b.type) || '(空)'), size: (b && b.size) || 0 }); return oc(b); };
})();
var cfg = { pdfWorkerSrc: '${WORKER}', pdfTimeoutMs: ${s.timeoutMs} };
function gmText(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }); }
// ---- 以下是从 .user.js 的 PDF-BEGIN/END 之间原样切出的生产代码 ----
${code}
// ---- 生产代码结束 ----
var R = [], done = false, t0 = 0;
function add(n, p, x) { R.push({ name: n, pass: !!p, extra: x == null ? '' : String(x) }); }
function render() {
  document.getElementById('rows').innerHTML = R.map(function (r) {
    return '<tr><td>' + r.name + '</td><td class="' + (r.pass ? 'pass">PASS' : 'fail">FAIL') + '</td><td class="extra">' +
      String(r.extra).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</td></tr>';
  }).join('');
  document.getElementById('lgs').textContent = LOGS.join(String.fromCharCode(10));
  var bad = R.filter(function (r) { return !r.pass; }).length;
  document.getElementById('sum').innerHTML = bad ? '<span class="fail">' + bad + ' 项失败</span> / 共 ' + R.length + ' 项'
    : '<span class="pass">全部 ' + R.length + ' 项通过</span>';
  window.__RESULT = R;
}
function finish() { if (done) return; done = true; clearTimeout(watchdog); render(); }
var watchdog = setTimeout(function () {
  add('跑完（没挂死）', false, '卡住了，' + Math.round(performance.now() - t0) + 'ms 仍无结论；阶段日志：' + LOGS.join(' | '));
  render();
}, 45000);
(async function () {
  t0 = performance.now();
  add('pdf.js 从镜像加载成功', typeof pdfjsLib !== 'undefined', typeof pdfjsLib === 'undefined' ? 'undefined（网络不通）' : 'v' + pdfjsLib.version);
  if (typeof pdfjsLib === 'undefined') { return finish(); }
  var bin = atob(window.__B64);
  var buf = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  var text = null, err = null;
  try { text = await pdfToText(buf); } catch (e) { err = e; }
  var ms = Math.round(performance.now() - t0);
  var all = LOGS.join(' ');
  document.getElementById('txt').textContent = text || '';
  var routeM = all.match(/PDF 解析成功：路线「([^」]+)」/);
  var route = routeM ? routeM[1] : null;
  ${s.expectRoute ? `add('走通路线「${s.expectRoute}」', route === '${s.expectRoute}', '实际：' + (route || ('报错：' + String(err && err.message || err).slice(0, 90))));` : `add('路线 1 被 CSP 拦住并记录', /沙箱里 eval 被拦|没拿到 WorkerMessageHandler/.test(all), (all.match(/路线 1[^|]{0,60}/) || ['无'])[0]);`}
  ${s.expectAttempt ? `add('按顺序退到了「${s.expectAttempt}」', new RegExp('${s.expectAttempt}').test(all), (all.match(/PDF worker：[^|]{0,34}/g) || ['无']).join('  ->  '));` : ''}
  ${s.expectBlob ? `add('造出了带 JS MIME 的同源 blob worker 源码', __blobs.some(function (b) { return b.type === 'text/javascript' && b.size > 500000; }), JSON.stringify(__blobs));` : ''}
  add('有明确结论（没静默挂死）', !!text || !!err, text ? text.length + ' 字 / ' + ms + 'ms' : '抛错 / ' + ms + 'ms');
  if (text) {
    add('抽出文本超过 200 字', text.length > 200, text.length + ' 字');
    add('中文未乱码', /订单中台/.test(text) && /重构/.test(text) && /主导/.test(text), '');
    add('英文技术栈命中', /Spring Boot/.test(text) && /Kubernetes/.test(text) && /Elasticsearch/.test(text), '');
    add('数字与薪资格式命中', /6000/.test(text) && /20-35K/.test(text) && /99\\.99/.test(text), '');
    add('按视觉行还原（有换行分段）', /后端开发工程师/.test(text) && text.indexOf(String.fromCharCode(10)) > 0, JSON.stringify(text.slice(0, 40)));
  } else {
    ${s.expectRoute ? '' : `add('报错里说清试过哪几条路（用户能自己判断）', /试过 /.test(String(err && err.message || '')), String(err && err.message || '').slice(0, 130));`}
    add('失败时给出 .txt 兜底指引', /\\.txt|粘贴/.test(String(err && err.message || '')), String(err && err.message || '').slice(0, 160));
  }
  finish();
})();
<\/script>
</body></html>
`;
}

const names = [];
for (const s of SCENARIOS) {
  const f = 'test/pdf-' + s.key + '.html';
  fs.writeFileSync(path.join(root, f), page(s));
  names.push(f + '（' + s.title + '）');
}
console.log('生成 ' + names.join('、') + '；PDF ' + Math.round(fs.statSync(fixturePdf).size / 1024) +
  ' KB / 注入生产代码 ' + code.split('\n').length + ' 行');
