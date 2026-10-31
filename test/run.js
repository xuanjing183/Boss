/*
 * 一条命令跑完所有测试：node test/run.js
 *   1) test/build-test.js -> scraper-test.html  纯 DOM 抓取启发式
 *   2) test/build-ui.js   -> ui-smoke.html      端到端闭环 + 三种发送结局，GM API 打桩
 *                          -> ui-sendtab.html   「被开出来的岗位标签页」接收端（自动点立即沟通并发送）
 *                          -> ui-listsend.html  「脚本开出来的列表页标签」发送路线 A（点卡片自己的沟通按钮）
 *   3) test/build-pdf.js  -> pdf-main / pdf-blob / pdf-remote
 *                            真实中文 PDF + 三种 CSP，验 worker 降级链（要联网）
 * 用本机 Edge/Chrome 的 headless 模式渲染，不碰你的登录数据。
 *
 * 两个必须照做的坑（本机 Edge 155 + Windows 实测）：
 *   - --dump-dom 的结果只能重定向到**文件**。Edge 是 GUI 子系统程序，Node 用管道
 *     捕获它的 stdout 会拿到 0 字节（不报错），于是一片「一条断言都没产出」。
 *   - 不要传 --user-data-dir。带着它启动时 Edge 直接退出 13：
 *     「Multiple targets are not supported in headless mode」。headless 模式本来
 *     就用一次性临时 profile，不需要指定。
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function findBrowser() {
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('没找到 Edge/Chrome，请手动改 findBrowser() 里的路径');
}

function parse(htmlPath) {
  const h = fs.readFileSync(htmlPath, 'utf8');
  const rows = [...h.matchAll(/<tr><td>([\s\S]*?)<\/td><td class="(pass|fail)">(\w+)<\/td><td class="extra">([\s\S]*?)<\/td><\/tr>/g)];
  const sum = ((h.match(/<div id="sum">([\s\S]*?)<\/div>/) || [])[1] || '未产出结果').replace(/<[^>]+>/g, '').trim();
  return { sum, rows: rows.map((r) => ({ name: r[1].trim(), pass: r[3] === 'PASS', extra: r[4].trim() })) };
}

let failed = 0;
const filter = String(process.argv[2] || '').toLowerCase();
const browser = findBrowser();
console.log('浏览器: ' + browser + '\n');

const suites = [
  { build: 'test/build-test.js', html: 'test/scraper-test.html', label: '抓取逻辑 DOM 回归', budget: 4000 },
  // 发送路由断言里有一条要等满后台标签回执超时（60s）；「补抓详情」还有一条要等满
  // JD 抓取超时（90s，演的是后台标签白跑一趟），虚拟时间预算得给够。
  // v0.5.5 末尾那三组还要多付：交接失败那条真的等满 25 秒，暂停那条每条生成 6 秒。
  { build: 'test/build-ui.js', html: 'test/ui-smoke.html', label: '端到端闭环冒烟', budget: 820000 },
  { build: null, html: 'test/ui-sendtab.html', label: '后台标签页接收端（自动点立即沟通并发送）', budget: 40000 },
  // 「抓详情」那一半：被开出来的岗位详情页只抓 JD、不点任何按钮
  { build: null, html: 'test/ui-detail.html', label: '岗位详情页抓取（图2 那一页 → JD 回收）', budget: 30000 },
  // 「点继续沟通 -> 整页跳转 -> 沟通页接力发送」：同一个文件用 ?case= 演七种情形
  { build: null, html: 'test/ui-hop.html', url: 'test/ui-hop.html?case=ss', label: '发送接力 · sessionStorage 牌（主路径）', budget: 40000 },
  { build: null, html: 'test/ui-hop.html', url: 'test/ui-hop.html?case=ok', label: '发送接力 · 油猴存储牌 + 导航 URL 认身份', budget: 40000 },
  { build: null, html: 'test/ui-hop.html', url: 'test/ui-hop.html?case=dirty', label: '发送接力 · 岗位名混进地点，靠页面职位名认（用户日志那条）', budget: 40000 },
  { build: null, html: 'test/ui-hop.html', url: 'test/ui-hop.html?case=fill', label: '发送接力 · 半自动只填不发', budget: 40000 },
  { build: null, html: 'test/ui-hop.html', url: 'test/ui-hop.html?case=notitle', label: '发送接力 · 职位名拿不到时退成只填不发', budget: 40000 },
  { build: null, html: 'test/ui-hop.html', url: 'test/ui-hop.html?case=wrong', label: '发送接力 · 会话对不上号必须停手', budget: 40000 },
  { build: null, html: 'test/ui-hop.html', url: 'test/ui-hop.html?case=stale', label: '发送接力 · 过期的牌作废，不留地雷', budget: 40000 },
  // 发送路线 A（v0.5.0）：脚本自己开的那个列表页标签里，认卡片 -> 悬停 -> 点卡片自己的沟通按钮
  // 最慢的一条是「列表页里没这张卡片」： rnd 等待 + 12s 边滚边找 + 写回执，断言那边还留了余量
  { build: null, html: 'test/ui-listsend.html', url: 'test/ui-listsend.html?case=ok', label: '列表卡片入口 · 认出这张卡片并点它自己的沟通按钮', budget: 60000 },
  { build: null, html: 'test/ui-listsend.html', url: 'test/ui-listsend.html?case=lazy', label: '列表卡片入口 · 懒加载滚一屏才出现的卡片', budget: 60000 },
  { build: null, html: 'test/ui-listsend.html', url: 'test/ui-listsend.html?case=absent', label: '列表卡片入口 · 没有这张卡片 -> 退回详情页入口', budget: 60000 },
  { build: null, html: 'test/ui-listsend.html', url: 'test/ui-listsend.html?case=noentry', label: '列表卡片入口 · 卡片上没有沟通按钮 -> 退回详情页入口', budget: 60000 },
  // 「往上找按钮」这条路径的边界：邻卡那颗按钮没有 redirect-url 时，jobId 那道闸门管不着，只能靠边界挡住
  { build: null, html: 'test/ui-listsend.html', url: 'test/ui-listsend.html?case=foreign', label: '列表卡片入口 · 越界就会点到邻卡按钮，边界必须挡住', budget: 60000 },
  { build: null, html: 'test/ui-listsend.html', url: 'test/ui-listsend.html?case=wrongentry', label: '列表卡片入口 · 按钮指向别的 jobId，停手且不换入口重试', budget: 60000 },
  { build: null, html: 'test/ui-listsend.html', url: 'test/ui-listsend.html?case=stale-tab', label: '列表卡片入口 · 用户早就开着的列表页绝不认领', budget: 60000 },
  // 认领要「标记」和「够新」两个条件同时成立，所以各拆一条：只有新的（用户发送途中自己开的页）、
  // 只有旧标记的（从上一条复制地址开的页）——少任何一个条件都不许点用户那一页。
  { build: null, html: 'test/ui-listsend.html', url: 'test/ui-listsend.html?case=fresh-tab', label: '列表卡片入口 · 用户发送途中刚打开的列表页（够新但没标记）绝不认领', budget: 60000 },
  { build: null, html: 'test/ui-listsend.html', url: 'test/ui-listsend.html?case=stale-mark', label: '列表卡片入口 · 带着上一条 #bgSend 标记但比请求还老，不认领', budget: 60000 },
  { build: null, html: 'test/ui-listsend.html', url: 'test/ui-listsend.html?case=navmark', label: '列表卡片入口 · 站点洗掉 hash，靠导航记录里的标记认领', budget: 60000 },
  { build: null, html: 'test/ui-listsend.html', url: 'test/ui-listsend.html?case=claimed', label: '列表卡片入口 · 请求已被别的标签页认领，不跑第二遍', budget: 60000 },
  { build: null, html: 'test/ui-listsend.html', url: 'test/ui-listsend.html?case=fill', label: '列表卡片入口 · 半自动走到沟通页只填不发', budget: 60000 },
  // v0.5.5 的「生成器」标签页：认领的两道闸门 / 心跳 / 真暂停真停止 / 用完自己关。
  // ok、navmark 每条生成 6 秒（要留出「跑一半时离开」的观察窗口），stop 每条 8 秒再等它收摊，
  // 拒认那几种也要等满 3 秒确认「真的什么都没发生」，所以预算都不小。
  { build: 'test/build-ui.js', html: 'test/ui-exec.html', url: 'test/ui-exec.html?case=ok', label: '生成器标签页 · 认领这一轮并跑完（心跳/日志分开/用完自关）', budget: 90000 },
  { build: null, html: 'test/ui-exec.html', url: 'test/ui-exec.html?case=navmark', label: '生成器标签页 · 站点洗掉 hash，靠导航记录里的标记认领', budget: 90000 },
  { build: null, html: 'test/ui-exec.html', url: 'test/ui-exec.html?case=nomark', label: '生成器标签页 · 用户自己开的普通页（没标记）绝不认领', budget: 40000 },
  { build: null, html: 'test/ui-exec.html', url: 'test/ui-exec.html?case=stale-tab', label: '生成器标签页 · 有标记但这一页比交接单老，不认领', budget: 40000 },
  { build: null, html: 'test/ui-exec.html', url: 'test/ui-exec.html?case=stale-mark', label: '生成器标签页 · 这一页够新但标记是上一轮的，不认领', budget: 40000 },
  { build: null, html: 'test/ui-exec.html', url: 'test/ui-exec.html?case=claimed', label: '生成器标签页 · 单已被别的生成器认领，不跑第二遍', budget: 40000 },
  { build: null, html: 'test/ui-exec.html', url: 'test/ui-exec.html?case=liveother', label: '生成器标签页 · 那一轮还有人跑 → 不抢，自己收摊', budget: 40000 },
  { build: null, html: 'test/ui-exec.html', url: 'test/ui-exec.html?case=stop', label: '生成器标签页 · 观众页的暂停/停止在这半边真的生效', budget: 120000 },
  { build: 'test/build-pdf.js', html: 'test/pdf-main.html', label: '真实中文 PDF · 主线程 worker（硬断言）', budget: 70000, optional: true },
  { build: null, html: 'test/pdf-blob.html', label: '真实中文 PDF · 禁 eval 时退到同源 blob worker', budget: 60000, optional: true },
  { build: null, html: 'test/pdf-remote.html', label: '真实中文 PDF · 只剩远程 worker 时不许静默挂死', budget: 40000, optional: true }
];

function render(browser, url, budget, out) {
  // 渲染交给 test/headless.ps1：Edge 是 GUI 子系统程序，Node 的管道和 cmd 的 ">"
  // 重定向都收不到 --dump-dom 的输出（0 字节、不报错），只有 PowerShell
  // Start-Process -RedirectStandardOutput 落文件才拿得到。
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'headless.ps1'),
    '-Url', url, '-Out', out, '-Budget', String(budget), '-Exe', browser
  ], { cwd: root, encoding: 'utf8', timeout: (Math.round(budget / 1000) + 240) * 1000 });
  // 这个上限必须比 headless.ps1 自己那道 deadline（budget/1000 + 180 秒）再晚 60 秒：
  // 让 ps1 先超时、自己 Kill 掉 Edge，Node 才跟着收。反过来的话被杀的是 powershell，
  // Edge 还在后台跑 —— 本机就是这么攒下 60 多个 headless 进程、把后面的套件拖慢一倍的。
  return (r.stdout || '') + (r.stderr || '');
}

for (const s of suites) {
  // 只跑某一组：node test/run.js listsend   （按 URL/标签子串过滤，全套跑一次要十几分钟，改一条断言时不用等）
  if (filter && !((s.url || s.html) + ' ' + s.label).toLowerCase().includes(filter)) continue;
  if (s.build) execFileSync('node', [s.build], { cwd: root, stdio: 'inherit' });
  if (!fs.existsSync(path.join(root, s.html))) { console.log('=== ' + s.label + ' === 跳过（没生成 ' + s.html + '）\n'); continue; }
  const tag = (s.url || s.html).replace(/[^a-z0-9]+/gi, '_');
  const out = path.join(root, 'test', '_run_' + tag + '.html');
  const log = render(browser, 'file:///' + path.join(root, s.url || s.html).replace(/\\/g, '/'), s.budget, out);
  const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
  if (!size) {
    failed++;
    console.log('=== ' + s.label + ' === ✗ headless 没吐任何 HTML（0 字节）');
    console.log('    ' + log.replace(/\s+/g, ' ').slice(0, 300));
    console.log('    参考 test/headless.ps1 顶部三条实测结论\n');
    continue;
  }
  const r = parse(out);
  if (s.optional && r.rows.some((x) => /pdf\.js 从镜像加载成功/.test(x.name) && !x.pass)) {
    console.log('=== ' + s.label + ' === ⚠ 跳过：npmmirror 镜像这次不通（网络/代理），不是脚本问题\n');
    continue;
  }
  if (!r.rows.length) {
    failed++;
    console.log('=== ' + s.label + ' === ✗ 一条断言都没产出（页面脚本抛错或没加载），摘要：' + r.sum);
    console.log('    用 --enable-logging=stderr 重跑可看控制台错误\n');
    continue;
  }
  console.log('=== ' + s.label + ' === ' + r.sum + ' (' + r.rows.length + ' 条断言)');
  r.rows.forEach((x) => {
    if (!x.pass) failed++;
    console.log((x.pass ? '  ok   ' : '  FAIL ') + x.name + (x.pass ? '' : '   -> ' + x.extra.slice(0, 160)));
  });
  console.log('');
}

console.log(failed ? '✗ 共 ' + failed + ' 项失败' : '✓ 全部通过');
process.exit(failed ? 1 : 0);
