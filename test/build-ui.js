/*
 * 端到端冒烟测试：把 .user.js 原样注入页面，用桩替换全部 GM_* API 和大模型请求，
 * 在真实浏览器 DOM 里走一遍「填设置 -> 存简历 -> 抓岗位 -> 生成草稿 -> 发送给站点输入框」。
 * 用法：node test/build-ui.js  然后 headless Edge 渲染 test/ui-smoke.html
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'boss-zhipin-llm-greet.user.js'), 'utf8')
  .replace(/<\/script>/gi, '<\\/script>');

const stubs = String.raw`
window.__store = {};
// 起手先关掉「抓完列表自动进详情页」：这样开头几条断言演的是「一条 JD 都没有」的硬拦现场，
// 自动路径留在流程末尾单独开（见「抓完列表自动进详情页」那组断言）。
// genConcurrency 起手设 1：v0.5.2 之前所有批量断言写的都是「逐条」现场，先按老语义跑，
// 并发本身在末尾「并发生成」那一组单独验（那里会把它调到 3 再验上限、重复请求、发送仍串行）。
// bgExecutor 起手关掉：v0.5.5 把批量搬到后台「生成器」标签页，但面板/队列/发送那 226 条断言写的
// 全是「这一页自己跑完一整轮」的现场，一开交接就要每条先等满 25 秒再退回，等于把老断言全泡掉。
// 所以这一页先把老路子钉住，交接本身用 simExecTab + 末尾「生成器」那一组和 test/ui-exec.html 验。
window.__store.cfg = { autoFetchDetail: false, genConcurrency: 1, bgExecutor: false };
window.__reqs = [];
window.__inflight = 0;        // 当前在飞的大模型请求数
window.__peakInflight = 0;    // 峰值：断言「并发生成数」真的被 honoring，而不是写个数字没用
window.__dupGen = 0;          // 同一条提示词同时在飞两次（= 重复烧 token 的 bug）
window.__sendOverlap = 0;     // 两条 sendReq 同时活着（= 发送被并发了，站点侧看到连点 + 回执互相冲掉）
window.__genDelay = 0;        // >0 时把大模型响应拖这么久，好让「同时在飞」可观察
window.__sendDelay = 0;       // >0 时把「后台标签发完回回执」拖这么久：真实站点那一跳要好几秒，
                              // 回执 30ms 就回来时，发送方就算不 await 也撞不上车（等于没测），必须能拖慢才验得出串行
window.__sent = [];
window.__errors = [];
window.__menuCmds = [];
window.onerror = function (msg, srcUrl, line, col, err) {
  window.__errors.push(msg + (err && err.stack ? ' @ ' + String(err.stack).split('\n')[1].trim() : ''));
};
function GM_getValue(k, d) { return (k in window.__store) ? window.__store[k] : (d === undefined ? null : d); }
function GM_setValue(k, v) {
  // 发送仍然必须逐条：两条 sendReq 同时活着 = 前一条还没拿到回执就被后一条盖掉，
  // 谁都没法确认自己那条发没发出去（并发生成绝不能把发送也带成并发，这条有断言钉着）
  if (k === 'sendReq' && v && window.__store.sendReq) window.__sendOverlap++;
  window.__store[k] = v;
}
function GM_deleteValue(k) { delete window.__store[k]; }
// v0.5.3 的「已发出」凭证是一条岗位一个键（bgSent:<id>），清空列表/重置要靠它按前缀扫，
// 真实油猴有这个 API，桩就照存储的键名顺序回一份
function GM_listValues() { return Object.keys(window.__store); }
function GM_registerMenuCommand(name, fn) { window.__menuCmds.push([name, fn]); }
// 模拟「被脚本开出来的后台标签页」：真实场景下那边跑的是 maybeHandleSendRequest -> sendMessage。
// headless 里开不出带 BOSS 登录态的标签页，所以这里只按 __tabMode 伪造回执，用来验跨标签协议本身：
//   ok   = 那边发出去了        fail = 那边点了发送但输入框没清空        dead = 那边压根没回执（登录墙/结构变了）
window.__tabMode = 'ok';
// v0.4.2 起「没有 JD 就不给生成」是硬拦，所以面板这边必须真的能拿到 JD，否则整条生成链路测不动。
// headless 开不出带 BOSS 登录态的详情页，这里替那个标签页把产物写回油猴存储：
// 只在「这条 URL 确实躺在 pendingDetails 里、且 jobs 里有对应岗位」时才写，
// 抓 JD 的规则本身（认牌/取正文/销账/自动关）由 test/ui-detail.html 那套断言去验。
// window.__detailTabOff = true 可以演「后台标签抓了个空手回来」（详情页改版/被登录墙挡住）。
function simDetailTab(u) {
  if (window.__detailTabOff) return;
  var pend = (window.__store.pendingDetails || []).filter(function (p) { return p.url === u; })[0];
  if (!pend) return;
  var job = (window.__store.jobs || []).filter(function (j) { return j.id === pend.id; })[0];
  if (!job) return;
  setTimeout(function () {
    var allD = window.__store.details || {};
    if (allD[pend.id] && allD[pend.id].text) return;   // 已有 JD 不重抓，和 fetchDetails 的取舍一致
    allD[pend.id] = {
      id: pend.id, title: job.title, ts: Date.now(),
      text: '职位描述：\n后台标签抓回的 JD：负责订单补偿链路与核心链路降级。JD-BG-' + String(pend.id).slice(0, 6) +
        '\n任职要求：\n精通 Java、Spring、MySQL，熟用 Redis 与消息队列。'
    };
    window.__store.details = allD;
  }, 60);
}
// 发送路线 A 的「列表页标签」：面板侧只验路由决策，所以这里直接按模式伪造那份回执。
//   ok   = 列表页上点成了，消息发出去了        fail = 这条路走不通（needJobTab，面板自动退回详情页）
//   dead = 那趟标签压根没回执（演 60s 超时）
window.__listTabMode = 'fail';
window.__listReq = null;
// v0.5.5 的「生成器」标签页：面板点「开始批量」会 GM_openInTab 一个带 #bgExec= 标记的后台页。
// 这里不用桩伪造它该写的存储 —— 那样只能验「面板以为别人在跑」，草稿指纹、心跳、认领全是我想象出来的。
// 单文件里造「另一页」的既有手法（见 reboot）：把这一页的地址挂上那一页带来的 #bgExec= 标记，
// 再把 .user.js 原文执行一遍。新执行 = 新闭包，boot 第一步就认这张交接单，于是 runExecutor ->
// runBatch -> 写草稿（含它自己算的真指纹）-> 心跳 -> 收摊，全是脚本自己的代码在跑。
// 唯一要骗的是「这一页比交接单新」：真实新标签页的 performance.timeOrigin 就是刚才，
// 模拟页的 timeOrigin 还是本文件加载那一刻，所以起闭包前把它顶成现在（只影响这一处判据）。
// window.__execSpawn = 'none' 演「那一页压根没起来」（没被油猴注入 / 被登录墙挡住）：面板等满 25 秒退回自己跑。
window.__execSpawn = 'real';
window.__execTabs = 0;
window.__closed = 0;
// 生成器用完会 window.close()：headless 里真关就把整份断言冲掉了，计数代替
window.close = function () { window.__closed++; };
function simExecTab(u) {
  var m = /#bgExec=([a-z0-9]+)/.exec(String(u || ''));
  if (!m) return;
  window.__execTabs++;
  if (window.__execSpawn !== 'real') return;
  var req0 = window.__store.bgExec;
  if (!req0 || req0.token !== m[1] || req0.claimed) return;
  setTimeout(function () {
    try { location.hash = 'bgExec=' + m[1]; } catch (e) {}
    try { Object.defineProperty(performance, 'timeOrigin', { value: Date.now(), configurable: true, writable: true }); } catch (e) {}
    // 这份闭包演的是「另一张标签页」，但它挂的 beforeunload 会作用到**本文档**：那样
    // 「观众页不拦你离开」那条断言就被生成器替它挡下了（假绿，同教训 14 那个 DOM 串味）。
    // 所以起闭包这段时间把 beforeunload 的注册收下来放进 __execGuards —— 真机上它是另一张
    // 标签页的窗口，本来就不该拦本文档；想验「护栏确实挪到了执行者身上」由断言自己调这个数组。
    var realAdd = window.addEventListener;
    window.__execGuards = [];
    window.addEventListener = function (t, f, o) {
      if (t === 'beforeunload') { window.__execGuards.push(f); return; }
      return realAdd.apply(window, arguments);
    };
    try { (0, eval)(document.getElementById('bgSrc').textContent); }
    finally { window.addEventListener = realAdd; }
  }, 60);
}
function simListTab(req) {
  var rid = String(req.id).slice(0, 24);
  setTimeout(function () {
    var all = window.__store.sendRes || {};
    all[rid] = window.__listTabMode === 'ok'
      ? { url: req.url, jobId: req.id, ok: true, why: '', how: 'button', filled: false, needJobTab: false }
      : { url: req.url, jobId: req.id, ok: false, how: '', filled: false, needJobTab: true,
          why: '列表页里没找到这张岗位卡片（大概被取消收藏了、在后面几页里，或者列表页改版）' };
    window.__store.sendRes = all;
  }, window.__sendDelay || 40);
}
function GM_openInTab(u) {
  (window.__opened = window.__opened || []).push(u);
  simDetailTab(u);
  simExecTab(u);
  var req = window.__store.sendReq;
  if (req && req.via === 'list') {
    // 发送路线 A：面板开的是「那个列表页 + #bgSend= 标记」。只有 URL 真的对得上才演接收端，
    // 对不上就一条回执都不写 —— 这样「面板开对没开对地址」这条断言才有牙齿（开错了就是 60s 超时）。
    // 列表页标签本身的行为由 test/ui-listsend.html 全套盯，这里只验面板这一半的路由决策。
    window.__listReq = { url: u, via: req.via, listUrl: req.listUrl, jobUrl: req.url, id: req.id, fillOnly: !!req.fillOnly };
    if (u === String(req.listUrl).split('#')[0] + '#bgSend=' + String(req.id).slice(0, 24) && window.__listTabMode !== 'dead') {
      simListTab(req);
    }
    return { close: function () {} };
  }
  if (req && req.url === u && window.__tabMode !== 'dead') {
    var rid = String(req.id).slice(0, 24);
    setTimeout(function () {
      var all = window.__store.sendRes || {};
      all[rid] = window.__tabMode === 'fail'
        ? { url: u, ok: false, why: '点了发送但输入框没清空，消息大概率没发出去，请人工确认（本次不会标记为已发送）', how: 'button' }
        : req.fillOnly
          ? { url: u, ok: false, filled: true, how: 'filled', why: '已在沟通页把招呼语填进输入框，请去那个标签页看一眼后自己点「发送」（没标记为已发送）' }
          : { url: u, ok: true, why: '', how: 'button' };
      window.__store.sendRes = all;
    }, window.__sendDelay || 30);
  }
  return { close: function () {} };
}
function GM_xmlhttpRequest(o) {
  window.__reqs.push({ url: o.url, headers: o.headers, data: o.data, method: o.method });
  var isGen = /\/chat\/completions$/.test(o.url);
  if (isGen) {
    // 记录同时在飞的大模型请求数与峰值，用来验「并发生成数」这条设置真的生效；
    // 同一份提示词第二次进来还挂着 = 重复烧 token（批量和手点撞在同一条岗位上）。
    window.__inflight++;
    if (window.__inflight > window.__peakInflight) window.__peakInflight = window.__inflight;
    // 用整份请求体当键（同一岗位同一份提示词才可能字节相同），
    // 截前缀会把「所有岗位共用的那段 system 提示词」当成键，不同岗位会被误判成重复。
    var kk = String(o.data || '');
    window.__live = window.__live || {};
    if (window.__live[kk]) window.__dupGen++;
    window.__live[kk] = 1;
  }
  setTimeout(function () {
    if (isGen) {
      window.__inflight--;
      delete window.__live[String(o.data || '')];
    }
    if (isGen) {
      // 每次生成的文本都不一样：断言「发出去的就是这条草稿」才不会被上一轮的旧值蒙混过关
      window.__genSeq = (window.__genSeq || 0) + 1;
      o.onload({ status: 200, responseText: JSON.stringify({
        choices: [{ message: { content: '招呼语第' + window.__genSeq + '条：我有 5 年 Java 后端经验，做过订单中台和稳定性治理，想聊聊你们这个岗位，方便发份简历吗？' } }]
      }) });
    } else if (/pdf\.worker/.test(o.url)) {
      o.onerror({});
    } else {
      o.onload({ status: 404, responseText: '{}' });
    }
  }, isGen ? (window.__genDelay || 5) : 5);
  return { abort: function () {} };
}
// 站点输入框/按钮的事件全部仿真真实框架的行为：
//   · 输入框空的时候「发送」带 class="disabled"，点它什么都不发生（真站点就是这样）
//   · 收到 input 事件才解禁 —— 所以脚本必须走真实输入通道，光改 textContent 不够
document.addEventListener('DOMContentLoaded', function () {
  var ta = document.querySelector('.chat-input');
  var btn = document.querySelector('#sendBtn') || document.querySelector('.btn-send') || document.querySelector('.send-btn');
  window.__fileClicks = 0;
  window.__greetClicks = 0;
  window.__wrapClicks = 0;
  window.chatVal = function () { return ta.value !== undefined && ta.tagName !== 'DIV' ? ta.value : (ta.textContent || ''); };
  ta.addEventListener('input', function () {
    if (String(window.chatVal()).trim()) btn.classList.remove('disabled');
    else btn.classList.add('disabled');
  });
  btn.addEventListener('click', function () {
    var v = String(window.chatVal()).trim();
    if (!v || /disabled/.test(btn.className)) return;
    window.__sent.push(v);
    if (ta.tagName === 'DIV') ta.textContent = ''; else ta.value = '';
    btn.classList.add('disabled');
  });
  // 仿真的「发送图片」控件：class 里带 send、文字也叫「发送」、里面藏着 file input。
  // 旧版 clickSend 用 className 含 send 去猜按钮，真实站点上命中的就是这种控件，
  // 一点就弹出系统的选图框（用户截图里那个 *.gif;*.jpg;*.png）。这里记录任何一次误点。
  document.querySelector('#imgBtn').addEventListener('click', function (e) { if (e.target === this) window.__fileClicks++; });
  document.querySelector('#fileIn').addEventListener('click', function () { window.__fileClicks++; });
  // 岗位详情页的沟通入口：真实结构是 wrap <div> 套一个 <a>，事件只绑在 <a> 上。
  // 脚本若按文档顺序点到外面那层 <div>，<a> 的处理器不会跑（冒泡只往上不往下）——
  // 这正是用户日志里「点了 15 秒没反应」的成因，所以这里原样复刻，让回归测试抓得住。
  var wrap = document.querySelector('#greetWrap');
  var greet = document.querySelector('#greetBtn');
  if (greet) greet.addEventListener('click', function () {
    window.__greetClicks++;
    document.querySelector('#chatBox').style.display = 'block';
    if (wrap) wrap.style.display = 'none';
  });
  if (wrap) wrap.addEventListener('click', function (e) { if (e.target === wrap) window.__wrapClicks++; });
});`;

const siteFixture = String.raw`
<div id="site">
  <div class="job-list-box">
    <div class="job-card-wrap"><div class="job-card-body"><div class="info-primary">
      <div class="job-name"><a class="job-title-link" href="https://www.zhipin.com/job_detail/aaa111.html">Java 后端工程师</a></div>
      <div class="salary-wrap"><span class="salary">20-35K·14薪</span></div>
      <div class="company-wrap"><a class="company-name" href="https://www.zhipin.com/gongsi/beijing.html">北京某某网络科技有限公司</a></div>
      <div class="company-location">海淀·中关村</div>
      <div class="tag-list"><span>Java</span><span>Spring</span><span>五险一金</span></div>
    </div></div></div>
    <div class="job-card-wrap"><div class="job-card-body"><div class="info-primary">
      <div class="job-name"><a class="job-title-link" href="https://www.zhipin.com/job_detail/bbb222.html">前端开发工程师</a></div>
      <div class="salary-wrap"><span class="salary">15-25K</span></div>
      <div class="company-wrap"><a class="company-name" href="https://www.zhipin.com/gongsi/sh.html">上海某智能科技有限公司</a></div>
      <div class="company-location">浦东·张江</div>
      <div class="tag-list"><span>React</span></div>
    </div></div></div>
    <div class="job-card-wrap"><div class="job-card-body"><div class="info-primary">
      <div class="job-name"><a class="job-title-link" href="https://www.zhipin.com/job_detail/ccc333.html">数据平台研发</a></div>
      <div class="salary-wrap"><span class="salary">25-50K·16薪</span></div>
      <div class="company-line"><span>杭州某数据有限公司</span></div>
      <div class="company-location">滨江·网商路</div>
      <div class="tag-list"><span>Flink</span></div>
    </div></div></div>
    <div class="job-card-wrap"><div class="job-card-body"><div class="info-primary">
      <div class="job-name"><a class="job-title-link" href="https://www.zhipin.com/job_detail/ddd444.html">运维工程师</a></div>
      <div class="company-wrap"><a class="company-name" href="https://www.zhipin.com/gongsi/cd.html">成都某网络安全有限公司</a></div>
    </div></div></div>
  </div>
  <!-- 收藏页上还有普通输入框（用户截图里被误填的就是「输入道具VIP兑换码」那一颗）。
       它可见、够宽、落在页面下半屏 —— 旧版 findChatInput 的兜底启发式正好全命中。
       现在只认聊天容器里的 contenteditable/textarea，任何 <input> 都不算聊天框。 -->
  <div class="vip-box"><input id="vipCode" type="text" placeholder="输入道具VIP兑换码"><button type="button" class="vip-btn">兑换</button></div>
  <div class="btn btn-startchat-wrap" id="greetWrap" style="display:none"><a class="btn btn-startchat" id="greetBtn" href="javascript:;" redirect-url="/web/geek/chat?id=bb1&amp;jobId=aaa111&amp;securityId=s1" data-isfriend="false" data-url="/wapi/zpgeek/friend/add.json?jobId=aaa111">立即沟通</a></div>
</div>
<div id="chatBox">
  <div class="chat-tool">
    <div class="chat-send-img" role="button" title="发送图片" id="imgBtn"><input type="file" id="fileIn" accept="*.gif;*.jpg;*.png"><span>发送</span></div>
  </div>
  <div class="chat-input" contenteditable="true"></div>
  <div class="btn-v2 btn-sure-v2 disabled" id="sendBtn">发送</div>
  <div class="chat-tip">按Enter键发送，按Ctrl+Enter键换行</div>`;

const asserts = String.raw`
var R = [];
function add(n, p, x) { R.push({ name: n, pass: !!p, extra: x == null ? '' : String(x) }); }
function q(s) { return document.querySelector(s); }
function all(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
function clickTab(t) { q('#bgTabs button[data-t="' + t + '"]').click(); }
function waitFor(fn, ms) {
  return new Promise(function (res) {
    var t0 = Date.now();
    (function loop() { var v = fn(); if (v) return res(v);
      if (Date.now() - t0 > (ms || 4000)) return res(null); setTimeout(loop, 40); })();
  });
}
var RESUME = '张三 求职意向：Java 后端。5 年后端经验，主导订单中台重构，Spring Boot、MySQL、Redis、Kafka，QPS 从 800 提升到 6000，带过 4 人小组，英语可作工作语言。';

async function run() {
  await waitFor(function () { return q('#bgPanel'); }, 3000);
  add('面板在页面加载后自动构建', !!q('#bgPanel'));
  add('油猴菜单注册了 2 项', window.__menuCmds.length === 2, window.__menuCmds.map(function (m) { return m[0]; }).join(' / '));
  var ts = all('#bgTabs button').map(function (b) { return b.dataset.t; });
  add('五个标签齐全', JSON.stringify(ts) === JSON.stringify(['cfg', 'resume', 'jobs', 'queue', 'log']), ts.join(','));

  clickTab('cfg');
  add('设置页渲染出 API 输入', !!q('#c_key') && q('#c_key').type === 'password', q('#c_key') ? q('#c_key').type : 'missing');
  q('#c_base').value = 'https://api.test.local/v1';
  q('#c_key').value = 'sk-test-1234567890';
  q('#c_model').value = 'test-model';
  q('#c_save').click();
  await waitFor(function () { return window.__store.cfg && window.__store.cfg.apiKey; }, 1500);
  add('配置落到油猴存储', window.__store.cfg.apiBase === 'https://api.test.local/v1' && window.__store.cfg.model === 'test-model', JSON.stringify({ b: window.__store.cfg.apiBase, m: window.__store.cfg.model }));

  /* v0.6.1：用户从网页复制 API Base 时常带零宽空格/BOM（实测那条日志里地址前有一道看不见的缝），
     原样存进去会让 URL 失效，POST 退成站内相对路径打到 BOSS 自己的 nginx，只回一个 HTTP 405。
     存之前必须清干净，顺手吃掉多填的 /chat/completions。 */
  q('#c_base').value = '\u200B https://api.test.local/v1/chat/completions\uFEFF';
  q('#c_save').click();
  await waitFor(function () { return (window.__store.cfg || {}).apiBase === 'https://api.test.local/v1'; }, 1500);
  add('API Base 存前清洗：去掉零宽字符，去掉重复填的 /chat/completions',
    window.__store.cfg.apiBase === 'https://api.test.local/v1', JSON.stringify(window.__store.cfg.apiBase));

  clickTab('resume');
  q('#bgResume').value = RESUME;
  q('#r_save').click();
  await waitFor(function () { return window.__store.resumeText && window.__store.resumeText.length > 50; }, 1500);
  add('简历文本入库并计数', (window.__store.resumeText || '').length === RESUME.length, (window.__store.resumeText || '').length + ' 字');
  add('简历元信息回显', /已缓存/.test(q('#bgResumeMeta').textContent), q('#bgResumeMeta').textContent);

  clickTab('jobs');
  q('#j_here').click();
  await waitFor(function () { return (window.__store.jobs || []).length >= 4; }, 2500);
  add('抓当前页得到 4 个岗位', (window.__store.jobs || []).length === 4, JSON.stringify((window.__store.jobs || []).map(function (j) { return j.title; })));
  add('标题栏计数同步', /岗位 4/.test(q('#bgStat').textContent), q('#bgStat').textContent);
  add('岗位行渲染到面板', all('#j_list .job').length === 4, all('#j_list .job').length + ' 行');
  add('抓取时顺手记下「这条岗位是在哪个列表页看到的」（发送路线 A 靠它回那个列表页）',
    (window.__store.jobs || []).length === 4 && (window.__store.jobs || []).every(function (j) { return j.listUrl === location.href.split('#')[0]; }),
    JSON.stringify((window.__store.jobs || []).slice(0, 2).map(function (j) { return j.listUrl; })));

  /* ================= 第一段：没有 JD 就不给生成（用户定的硬拦） ================= */
  var js = window.__store.jobs || [];
  var id0 = js[0].id, id1 = js[1].id, id2 = js[2].id, id3 = js[3].id;
  function draftOf(id) { return (window.__store.drafts || {})[id]; }
  function rowOf(id) { return all('#q_list .job').filter(function (r) { return r.dataset.id === id; })[0]; }
  function genReqs() { return window.__reqs.filter(function (r) { return /\/chat\/completions$/.test(r.url); }); }
  function lastReq() { var l = genReqs(); return l[l.length - 1]; }
  function userPromptOf(r) {
    try { var b = JSON.parse((r || {}).data || '{}'); return (b.messages || [])[1] ? b.messages[1].content : ''; }
    catch (e) { return ''; }
  }
  function sleepMs(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  clickTab('cfg');
  add('设置页有「抓完列表自动进详情页」开关，勾选状态跟着存储走',
    !!q('#c_adet') && q('#c_adet').checked === false, 'checked=' + (q('#c_adet') ? q('#c_adet').checked : 'missing'));
  add('开关的说明文字不再承诺「关掉也能用卡片凑合」', !!q('#c_adet') && !/只能用列表卡片/.test(q('#c_adet').parentNode.textContent)
    && /不会让脚本改用卡片那一行凑合/.test(q('#c_adet').parentNode.textContent), (q('#c_adet') ? q('#c_adet').parentNode.textContent.slice(0, 60) : 'missing'));
  add('设置页有「优先在列表页卡片上点沟通按钮」开关，v0.5.0 起默认开着',
    !!q('#c_listsend') && q('#c_listsend').checked === true, 'checked=' + (q('#c_listsend') ? q('#c_listsend').checked : 'missing'));
  add('这个开关说清了走不通会自己退回详情页，也说了绝不在用户那一页点', (function () {
    var hint = q('#c_listsend') ? q('#c_listsend').closest('label').nextElementSibling : null;
    return !!hint && /退回/.test(hint.textContent) && /绝不在你正在看的那一页点/.test(hint.textContent);
  })(), (function () { var h = q('#c_listsend') ? q('#c_listsend').closest('label').nextElementSibling : null; return h ? h.textContent.slice(0, 40) : 'missing'; })());
  clickTab('jobs');
  var greetB0 = window.__greetClicks, wrapB0 = window.__wrapClicks;
  add('开关关着时抓完列表真的不乱开标签（想手动控制就不打扰）', (window.__opened || []).length === 0,
    'opened=' + (window.__opened || []).length);

  /* ============ v0.5.1：抓回来只是入库，勾上才算要处理（详情抓取跟着勾选走） ============ */
  add('新抓到的岗位默认一条都不勾（不再一抓就全塞进队列）',
    (window.__store.jobs || []).every(function (j) { return j.sel === false; }),
    JSON.stringify((window.__store.jobs || []).map(function (j) { return j.sel; })));
  add('一条都没勾时标题栏「选中」是 0', /选中 0/.test(q('#bgStat').textContent), q('#bgStat').textContent);
  clickTab('queue');
  add('没勾选就没有队列：四行岗位都不在这儿，只有一句「去岗位页勾选」',
    all('#q_list .job').length === 0 && /队列为空/.test(q('#q_list').textContent), q('#q_list').textContent.slice(0, 26));
  clickTab('jobs');
  var bx0 = all('#j_list input[type=checkbox]')[0];
  bx0.checked = true;
  bx0.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(function () { return (window.__store.jobs || [])[0].sel === true; }, 2000);
  add('勾一条就只进一条：标题栏「选中 1」', /选中 1/.test(q('#bgStat').textContent), q('#bgStat').textContent);
  clickTab('queue');
  add('队列实时多出这一行（不用重开面板）', all('#q_list .job').length === 1, all('#q_list .job').length + ' 行');
  clickTab('jobs');
  add('「自动抓详情」关着时，勾选也不开标签（节奏归用户自己掌握）',
    (window.__opened || []).length === 0, 'opened=' + (window.__opened || []).length);
  q('#j_all').click();          // 后面几段要四条都在队列里
  await waitFor(function () { return (window.__store.jobs || []).every(function (j) { return j.sel === true; }); }, 2000);

  clickTab('queue');
  add('队列 4 行全给「补抓详情并生成」，一个「生成」按钮都没有',
    all('#q_list .job').length === 4 && all('#q_list .fgen').length === 4 && all('#q_list .gen').length === 0,
    all('#q_list .fgen').length + ' fgen / ' + all('#q_list .gen').length + ' gen');
  add('缺 JD 的行把话说在前面（不是点了才弹一句报错）',
    /不给生成/.test(all('#q_list .job')[0].textContent) && /补抓详情并生成/.test(all('#q_list .job')[0].textContent),
    (all('#q_list .job')[0].querySelector('.warn') || {}).textContent);
  add('队列页表头写明「生成前每条都得先有 JD」', /生成前每条都得先有 JD/.test(q('#bgBody').textContent), '');
  var reqB0 = genReqs().length;
  q('#q_run').click();
  await waitFor(function () { return /批量任务结束/.test(q('#bgFoot').textContent); }, 30000);
  add('批量也绕不过拦截：一条大模型请求都没发出去', genReqs().length === reqB0, '新增 ' + (genReqs().length - reqB0) + ' 条请求');
  add('批量不产出任何草稿（免得队列里出现「已生成」骗人去发）', !window.__store.drafts || Object.keys(window.__store.drafts).length === 0,
    JSON.stringify(Object.keys(window.__store.drafts || {})));
  add('每条都标成「缺 JD 已跳过」，不是「出错」这种看不懂的词', /缺 JD 已跳过/.test(q('#q_list').textContent),
    (q('#q_list').textContent.match(/缺 JD 已跳过/g) || []).length + ' 行');
  clickTab('log');
  add('跳过原因连下一步该怎么办都写在日志里（判据只有一处：generateOne 抛的那条错）',
    /还没抓到岗位详情（JD），不给生成/.test(q('#bgLog').value) && /补抓详情并生成/.test(q('#bgLog').value),
    (q('#bgLog').value.match(/[^\n]*不给生成[^\n]*/g) || ['无'])[0]);

  /* ---- 一键补抓：拦死但不把人堵死 ---- */
  // 先演一次「后台标签白跑一趟」（详情页改版 / 被登录墙挡住都会这样）：
  // 这种情况下 fetchDetails 要空等到超时，所以这一段的耗时明显比别处长。
  clickTab('queue');
  window.__detailTabOff = true;
  var badOpened = (window.__opened || []).length;
  var badReq = genReqs().length;
  rowOf(id0).querySelector('.fgen').click();
  await waitFor(function () { return /JD 还是没抓到/.test(q('#bgFoot').textContent); }, 110000);
  add('后台标签没抓回 JD 时一个字都不发（不拿卡片那一行凑合写）', genReqs().length === badReq,
    '新增 ' + (genReqs().length - badReq) + ' 条请求');
  add('没 JD 就没有草稿：这一行还是「补抓详情并生成」，不出现「已生成」',
    !!rowOf(id0).querySelector('.fgen') && !draftOf(id0), (rowOf(id0).querySelector('.btns') || {}).textContent);
  clickTab('log');
  add('抓不到 JD 说得明明白白（可能的原因写在日志里）', /JD 还是没抓到/.test(q('#bgLog').value),
    (q('#bgLog').value.match(/[^\n]*还是没抓到[^\n]*/g) || ['无'])[0]);
  clickTab('jobs');
  add('岗位页这一条仍标「缺 JD 不生成」，不会假装「有详情」',
    /缺 JD 不生成/.test(all('#j_list .job')[0].querySelector('.mini').textContent),
    all('#j_list .job')[0].querySelector('.mini').textContent);
  window.__detailTabOff = false;

  clickTab('queue');
  var fOpened = (window.__opened || []).length;
  rowOf(id0).querySelector('.fgen').click();
  var fDone = await waitFor(function () { var r = rowOf(id0); return r && r.querySelector('button.snd'); }, 30000);
  add('点「补抓详情并生成」开的是这一条岗位的详情页',
    (window.__opened || []).length === fOpened + 1 && window.__opened[fOpened] === js[0].url,
    String((window.__opened || []).slice(fOpened)[0]) + ' vs ' + js[0].url);
  add('一键之后不用用户再点第二次：JD 到手、草稿写好、发送按钮自己出现', !!fDone, fDone ? '' : '这一行还是没有发送按钮');
  add('进提示词的是抓回来的 JD，不是列表卡片那一行',
    /岗位详情：/.test(userPromptOf(lastReq())) && /JD-BG-aaa111/.test(userPromptOf(lastReq())) && !/列表信息：/.test(userPromptOf(lastReq())),
    userPromptOf(lastReq()).slice(0, 46));
  var req0 = lastReq() || {};
  add('走了 GM_xmlhttpRequest 且是 OpenAI 兼容路径', /\/v1\/chat\/completions$/.test(req0.url || ''), req0.url);
  add('带 Bearer 认证头', (req0.headers || {}).Authorization === 'Bearer sk-test-1234567890', (req0.headers || {}).Authorization);
  var body0 = {};
  try { body0 = JSON.parse(req0.data); } catch (e) {}
  add('system/user 双消息 + 模型名', body0.model === 'test-model' && body0.messages.length === 2 && body0.messages[0].role === 'system',
    JSON.stringify({ model: body0.model, n: (body0.messages || []).length }));
  add('提示词含简历要点', /订单中台/.test(userPromptOf(req0)), '');
  add('提示词含岗位要点', /Java 后端工程师/.test(userPromptOf(req0)), '');
  add('提示词里没有泄漏 API Key', !/sk-test/.test(JSON.stringify(body0)), '');
  add('用了详情就不再塞列表信息（免得两份岗位描述互相打架）', !/列表信息：/.test(userPromptOf(req0)), '');
  add('抓到 JD 后这一行换回普通「生成」按钮', !!rowOf(id0).querySelector('.gen') && !rowOf(id0).querySelector('.fgen'),
    rowOf(id0) ? (rowOf(id0).querySelector('.btns') || {}).textContent : '行没了');
  add('补抓详情这一步一颗沟通按钮都没点（不会把话发给错的 HR）',
    window.__greetClicks === greetB0 && window.__wrapClicks === wrapB0,
    JSON.stringify({ greet: window.__greetClicks - greetB0, wrap: window.__wrapClicks - wrapB0 }));
  clickTab('log');
  add('这一步的日志说的是真开出去的数量', /打开 1 个后台标签抓详情/.test(q('#bgLog').value),
    (q('#bgLog').value.match(/打开 \d+ 个后台标签[^\n]*/g) || ['无']).join(' | '));

  /* ---- 手动「抓选中岗位详情」：按钮传进来的是 selected() 的岗位对象，不是 id ---- */
  var mOpened = (window.__opened || []).length;
  clickTab('jobs');
  q('#j_detail').click();
  clickTab('queue');
  // 等到 JD 真的都到手（4 行都换成普通生成按钮）再进行下一步：只等「标签开出去了」就往下跑，
  // 会在上一轮 fetchDetails 还在回收的时候又点一次，多开的那个标签是本测试自己制造的并发，不是产品问题。
  var allJd = await waitFor(function () {
    return all('#q_list .gen').length === 4 && all('#q_list .fgen').length === 0;
  }, 60000);
  var mUrls = (window.__opened || []).slice(mOpened);
  var jobUrls = js.map(function (j) { return j.url; });
  add('手动「抓选中岗位详情」真的开出剩下 3 个标签（把对象当 id 用的那类错误不再发生）',
    !!allJd && mUrls.length === 3, '新增 ' + mUrls.length + ' 个');
  add('开的是岗位卡片自己的详情链接（列表里那个 href，不是猜出来的 URL）',
    mUrls.every(function (u) { return jobUrls.indexOf(u) >= 0; }), JSON.stringify(mUrls));
  add('4 条岗位都有 JD 了：每行都是普通「生成」，没有一行还挂着补抓按钮', !!allJd,
    all('#q_list .gen').length + ' gen / ' + all('#q_list .fgen').length + ' fgen');
  clickTab('log');
  add('日志说的「打开 3 个后台标签」和真实开出去的数量一致（不打空炮）',
    /打开 3 个后台标签抓详情/.test(q('#bgLog').value), (q('#bgLog').value.match(/打开 \d+ 个后台标签[^\n]*/g) || ['无']).join(' | '));
  clickTab('jobs');
  var m2 = (window.__opened || []).length;
  q('#j_detail').click();
  await sleepMs(1500);
  add('JD 都在库里时不再重复开标签（也不再吹「打开 4 个后台标签」）',
    (window.__opened || []).length === m2, '新增 ' + ((window.__opened || []).length - m2) + ' 个');
  clickTab('log');
  add('库里都有了就直说，不空转', /都已经在库里/.test(q('#bgLog').value), (q('#bgLog').value.match(/[^\n]*库里[^\n]*/g) || ['无'])[0]);

  /* ---- JD 更新必须让旧草稿过期（详情在草稿指纹里） ---- */
  clickTab('queue');
  rowOf(id1).querySelector('.gen').click();
  await waitFor(function () { var r = rowOf(id1); return r && r.querySelector('button.snd'); }, 20000);
  add('已有 JD 的岗位点「生成」直接进模型，不重开标签',
    !!rowOf(id1).querySelector('button.snd') && (window.__opened || []).length === m2 + 0,
    'opened=' + ((window.__opened || []).length - m2));
  add('提示词里带上这条岗位自己的 JD（每条 marker 不同，不会被上一轮的旧值蒙混）',
    /JD-BG-bbb222/.test(userPromptOf(lastReq())), userPromptOf(lastReq()).slice(0, 40));
  // 换一整个顶层对象再写回去：真实场景里 JD 是另一个标签页写进油猴存储的，GM 存储会序列化，
  // 面板和它不可能是同一个引用。直接改 window.__store.details[id1] 的话，面板自己那份
  // 已经跟着变了、时间戳比较挑不出「有新东西」，2 秒一次的合并就不会触发重画。
  var detB = Object.assign({}, window.__store.details);
  detB[id1] = { id: id1, title: js[1].title, ts: Date.now() + 5000,
    text: '职位描述：\n这条岗位的 JD 改版了，改成推荐引擎方向。JD-MARKER-8882\n任职要求：\n精通 Java 与 Flink。' };
  window.__store.details = detB;
  var staled = await waitFor(function () {
    var r = rowOf(id1);
    return r && /过期/.test((r.querySelector('.st') || {}).textContent || '') && !r.querySelector('button.snd');
  }, 12000);
  add('后台重抓的 JD（时间戳更新）会被面板并回来，旧草稿立刻过期、撤掉发送按钮', !!staled,
    staled ? '已过期' : (rowOf(id1) ? (rowOf(id1).querySelector('.st') || {}).textContent : '行没了'));
  clickTab('queue');
  rowOf(id1).querySelector('.gen').click();
  var regen = await waitFor(function () {
    var r = rowOf(id1);
    return r && r.querySelector('button.snd') && !/过期/.test((r.querySelector('.st') || {}).textContent || '');
  }, 20000);
  var upAfter = userPromptOf(lastReq());
  add('重新生成用的是新版 JD，旧那份不再进提示词', !!regen && /JD-MARKER-8882/.test(upAfter) && !/JD-BG-bbb222/.test(upAfter),
    upAfter.slice(0, 46));

  var row0 = all('#q_list .job')[0];
  add('草稿回显在队列里', !!row0.querySelector('.draft') && /订单中台|Java/.test(row0.querySelector('.draft').textContent), row0.querySelector('.draft') ? row0.querySelector('.draft').textContent.slice(0, 28) : 'none');
  add('状态置为已生成', /已生成/.test(row0.querySelector('.st').textContent), row0.querySelector('.st').textContent);

  row0 = all('#q_list .job')[0];
  row0.querySelector('button.snd').click();
  var got = await waitFor(function () { return window.__sent.length > 0; }, 4000);
  add('点发送后站点的聊天输入框被填入', !!got, got ? JSON.stringify(window.__sent[0].slice(0, 24)) : '未捕获');
  add('发出的就是生成的草稿', !!got && window.__sent[0] === (window.__store.drafts || {})[(window.__store.jobs || [])[0].id].text, '');
  add('未误点面板自己的按钮', !!got && !/^生成$|^复制$/.test(window.__sent[0]), got ? JSON.stringify(window.__sent[0].slice(0, 12)) : '');
  await waitFor(function () { return /已发送/.test((document.querySelector('#q_list .job .st') || {}).textContent || ''); }, 2500);
  add('状态置为已发送', /已发送/.test((document.querySelector('#q_list .job .st') || {}).textContent || ''), (document.querySelector('#q_list .job .st') || {}).textContent);
  add('今日计数 +1', (window.__store.stats || {}).sent === 1, JSON.stringify(window.__store.stats));
  // v0.5.3：真发出去的那一瞬间，看见的人（可能是后台标签页）要在油猴存储里留一条持久凭证。
  // 面板这一页要是刚好在「把草稿标成已发送」之前被整页跳转销毁，标记就没了 —— 续跑会对着同一个
  // HR 再发一遍同样的话。凭证独立于面板的标记，所以它得单独存在、单独认。
  var sentId0 = (window.__store.jobs || [])[0].id;
  add('发出去的那一瞬间留下「这条已发出」的持久凭证（不依赖面板自己的标记）',
    !!(window.__store['bgSent:' + sentId0]), JSON.stringify(window.__store['bgSent:' + sentId0] || null));
  var d0 = window.__store.drafts[sentId0];
  d0.sent = false; delete d0.sentAt;      // 造「发成了但面板没来得及记」的现场：标记和今日计数一起抹掉
  window.__store.stats.sent = 0;          // （面板是在那一步之前被跳转销毁的，所以两个都还没记）
  var sentN0 = window.__sent.length;
  clickTab('queue');
  all('#q_list .job')[0].querySelector('button.snd').click();
  await sleepMs(1500);
  add('面板没记上的那条不会被重发：认持久凭证，只补记「已发送」，站点一个字都收不到',
    window.__sent.length === sentN0 && !!window.__store.drafts[sentId0].sent,
    JSON.stringify({ 又发出去: window.__sent.length - sentN0, 草稿标记: !!window.__store.drafts[sentId0].sent }));
  add('补记的那一条照常吃掉今日额度，而且只吃一次（不算漏、也不算重复计）',
    (window.__store.stats || {}).sent === 1, JSON.stringify(window.__store.stats));
  clickTab('log');
  add('补记这条在日志里说得清是谁发的（免得用户以为脚本漏发又点一次）',
    /在上一页就已经发出去了/.test(q('#bgLog').value),
    (q('#bgLog').value.split(String.fromCharCode(10)).filter(function (L) { return /上一页就已经发出/.test(L); }).pop() || '没有这行'));
  clickTab('queue');
  clickTab('log');
  var lg = q('#bgLog').value;
  add('日志页汇总了之前所有标签页的动作', /简历已保存/.test(lg) && /识别到 4 个岗位/.test(lg) && /已生成/.test(lg) && /发送成功/.test(lg), lg.split('\n').length + ' 行');
  var len0 = lg.length;
  clickTab('cfg'); clickTab('log');
  add('切走再回来日志不丢', q('#bgLog').value.length >= len0, q('#bgLog').value.length + ' vs ' + len0);
  add('底部状态条回显最近一条', /\]\s/.test(q('#bgFoot').textContent), q('#bgFoot').textContent);

  /* ============ 选中 = 队列：勾选状态和草稿缓存必须实时同步 ============ */
  var js0 = window.__store.jobs || [];
  var id0 = js0[0].id, id1 = js0[1].id, id2 = js0[2].id, id3 = js0[3].id;
  function draftOf(id) { return (window.__store.drafts || {})[id]; }
  function selArr() { return (window.__store.jobs || []).map(function (j) { return j.sel; }); }

  // 先造一条「未发送」草稿，作为待清理的缓存
  clickTab('queue');
  all('#q_list .job')[1].querySelector('.gen').click();
  await waitFor(function () { return draftOf(id1); }, 6000);
  add('造出一条未发送草稿', !!draftOf(id1) && draftOf(id1).sent !== true, '');

  // 岗位页取消勾选第 2 个岗位
  clickTab('jobs');
  var bx1 = all('#j_list input[type=checkbox]')[1];
  bx1.checked = false;
  bx1.dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(function () { return selArr()[1] === false; }, 2000);
  add('取消勾选写进油猴存储（刷新后不会自己变回全选）', selArr()[1] === false, JSON.stringify(selArr()));
  add('标题栏「选中」数同步', /选中 3/.test(q('#bgStat').textContent), q('#bgStat').textContent);
  clickTab('queue');
  add('切到队列页只剩勾选的 3 个', all('#q_list .job').length === 3, all('#q_list .job').length + ' 行');
  clickTab('jobs');
  add('未发送草稿被一起清掉', !draftOf(id1), JSON.stringify(Object.keys(window.__store.drafts || {})));
  add('已发送的草稿保留（不重复打扰同一个 HR）', !!draftOf(id0) && draftOf(id0).sent === true, '');
  add('岗位行的缓存标记同步', !/有草稿/.test(all('#j_list .job')[1].querySelector('.mini').textContent), all('#j_list .job')[1].querySelector('.mini').textContent);
  clickTab('log');
  add('丢草稿有日志', /丢掉.*未发送草稿/.test(q('#bgLog').value), (q('#bgLog').value.match(/丢掉[^\n]*/) || ['无'])[0]);

  // 全选/取消按钮必须真的改状态：老版本只改 DOM 的 checked，队列页照旧显示全部
  clickTab('jobs');
  q('#j_all').click();
  add('全选按钮真的改状态', selArr().every(function (s) { return s !== false; }) && /选中 4/.test(q('#bgStat').textContent), q('#bgStat').textContent);
  q('#j_all').click();
  add('全不选按钮真的改状态', selArr().every(function (s) { return s === false; }) && /选中 0/.test(q('#bgStat').textContent), q('#bgStat').textContent);
  clickTab('queue');
  add('全不选后队列为空', /队列为空/.test(q('#q_list').textContent), q('#q_list').textContent.slice(0, 26));
  clickTab('jobs');
  q('#j_all').click();
  add('再点一次恢复全选', /选中 4/.test(q('#bgStat').textContent), q('#bgStat').textContent);

  // 简历一改，旧草稿必须失效：不能拿旧简历写的话术去发新的 HR
  clickTab('resume');
  q('#bgResume').value = RESUME + ' 补充：熟悉 Go 与 Kubernetes。';
  q('#r_save').click();
  await waitFor(function () { return /Kubernetes/.test(window.__store.resumeText || ''); }, 2500);
  clickTab('queue');
  add('已发送的旧草稿不催过期', /已发送/.test(all('#q_list .job')[0].querySelector('.st').textContent), all('#q_list .job')[0].querySelector('.st').textContent);
  all('#q_list .job')[1].querySelector('.gen').click();
  await waitFor(function () { return draftOf(id1) && draftOf(id1).fp; }, 6000);
  add('按新简历重新生成并记下指纹', !!draftOf(id1) && !!draftOf(id1).fp, String(draftOf(id1) && draftOf(id1).fp));
  clickTab('resume');
  q('#bgResume').value = RESUME + ' 补充：熟悉 Go 与 Kubernetes，做过异地多活。';
  q('#r_save').click();
  await waitFor(function () { return /异地多活/.test(window.__store.resumeText || ''); }, 2500);
  clickTab('queue');
  var r1 = all('#q_list .job')[1];
  add('简历再变，旧草稿立刻标记过期', /过期/.test(r1.querySelector('.st').textContent) && !!r1.querySelector('.draft.stale'), r1.querySelector('.st').textContent);
  add('过期草稿不给发送按钮', !r1.querySelector('button.snd'), '');
  var nReq = window.__reqs.length;
  r1.querySelector('.gen').click();
  await waitFor(function () { return window.__reqs.length > nReq; }, 6000);
  await waitFor(function () { var el = all('#q_list .job')[1]; return el && !/过期/.test(el.querySelector('.st').textContent); }, 6000);
  add('点重新生成后过期标记消失', !/过期/.test(all('#q_list .job')[1].querySelector('.st').textContent), all('#q_list .job')[1].querySelector('.st').textContent);

  // 手动丢草稿
  all('#q_list .job')[1].querySelector('.drop').click();
  await waitFor(function () { return !draftOf(id1); }, 2500);
  add('丢草稿按钮清掉缓存并重画', !draftOf(id1) && !all('#q_list .job')[1].querySelector('.draft'), '');

  // 队列页直接「移出队列」，两边状态要一致
  var nBefore = all('#q_list .job').length;
  all('#q_list .job')[2].querySelector('.rm').click();
  await waitFor(function () { return all('#q_list .job').length === nBefore - 1; }, 2500);
  add('队列页「移出队列」立刻少一行', all('#q_list .job').length === nBefore - 1, all('#q_list .job').length + '/' + nBefore);
  add('移出队列同步写回勾选状态', selArr()[2] === false, JSON.stringify(selArr()));
  clickTab('jobs');
  add('岗位页勾选框跟着变', all('#j_list input[type=checkbox]')[2].checked === false, '');
  var bx2 = all('#j_list input[type=checkbox]')[2];
  bx2.checked = true;
  bx2.dispatchEvent(new Event('change', { bubbles: true }));
  add('岗位页重新勾选能加回队列', selArr()[2] !== false && /选中 4/.test(q('#bgStat').textContent), q('#bgStat').textContent);

  // 批量跑到一半取消勾选：剩下的必须跳过，不能照发
  clickTab('cfg');
  q('#c_dmin').value = '2000';
  q('#c_dmax').value = '2100';
  q('#c_save2').click();
  clickTab('queue');
  q('#q_run').click();
  q('#q_pause').click();
  await waitFor(function () { return /已暂停/.test(q('#bgFoot').textContent); }, 3000);
  clickTab('jobs');
  var bx3 = all('#j_list input[type=checkbox]')[3];
  bx3.checked = false;
  bx3.dispatchEvent(new Event('change', { bubbles: true }));
  clickTab('queue');
  q('#q_pause').click();
  await waitFor(function () { return /批量任务结束/.test(q('#bgFoot').textContent); }, 40000);
  add('批量途中取消勾选的岗位被跳过', !draftOf(id3), JSON.stringify(Object.keys(window.__store.drafts || {})));
  add('批量里其余岗位照常生成', !!draftOf(id2), '');
  add('已发送的岗位不会被重复处理', draftOf(id0) && draftOf(id0).sent === true && (window.__store.stats || {}).sent === 1, JSON.stringify(window.__store.stats));
  clickTab('log');
  var lg2 = q('#bgLog').value;
  add('跳过动作有日志', /已取消勾选，跳过/.test(lg2) && /跳过 1 个已发送过的岗位/.test(lg2), (lg2.match(/跳过[^\n]*/g) || ['无']).join(' | '));

  /* ============ 发送路由：半自动填当前页 / 全自动开后台标签，两条路都不能骗人 ============ */
  // 备料：把第 4 个岗位勾回来，并给每条都造一份未发送草稿（后面三种发送结局各要一条）
  clickTab('jobs');
  var bx4 = all('#j_list input[type=checkbox]')[3];
  if (!bx4.checked) { bx4.checked = true; bx4.dispatchEvent(new Event('change', { bubbles: true })); }
  for (var guard = 0; guard < 6; guard++) {
    clickTab('queue');
    var noDraft = all('#q_list .job').filter(function (r) { return !r.querySelector('.draft'); })[0];
    if (!noDraft) break;
    var rid = noDraft.dataset.id;
    noDraft.querySelector('.gen').click();
    await waitFor(function () {
      var el = all('#q_list .job').filter(function (r) { return r.dataset.id === rid; })[0];
      return el && el.querySelector('button.snd');
    }, 10000);
  }
  clickTab('queue');
  var ready = all('#q_list .job').filter(function (r) { return r.querySelector('button.snd'); }).length;
  add('备料：至少 3 条未发送草稿可用来验发送路由', ready >= 3, ready + ' 条 / 共 ' + all('#q_list .job').length + ' 行');

  // 半自动 · 情况一：你已经站在沟通页（这一页有输入框）→ 当场填好、点「发送」
  var greetB0 = window.__greetClicks, wrapB0 = window.__wrapClicks;
  clickTab('cfg');
  q('#m_semi').checked = true;
  q('#c_open').checked = true;
  // 这一整段（直到「后台标签没回执」那组）验的都是老的「岗位详情页入口」，先把新开关关掉：
  // 留着它，每条发送都会先扑一趟列表页标签再退回，__opened 计数和日志都不是在验这一条路了。
  // 列表入口自己在后面那组里验，跨标签那一半由 test/ui-listsend.html 全套盯着。
  q('#c_listsend').checked = false;
  q('#c_save2').click();
  await waitFor(function () { return window.__store.cfg && window.__store.cfg.autoOpenChat === true; }, 1500);
  add('「自动点击立即沟通」勾上后落库', window.__store.cfg.autoOpenChat === true && window.__store.cfg.autoSend === false,
    JSON.stringify({ open: window.__store.cfg.autoOpenChat, auto: window.__store.cfg.autoSend }));
  add('「优先列表卡片入口」关掉后也落库（老路子随时切得回去）', window.__store.cfg.sendViaList === false,
    String(window.__store.cfg.sendViaList));
  q('#chatBox').style.display = 'block';
  clickTab('queue');
  var gRow = all('#q_list .job').filter(function (r) { return r.querySelector('button.snd'); })[0];
  var gid = gRow.dataset.id;
  var gText = ((window.__store.drafts || {})[gid] || {}).text;
  var gSentBefore = window.__sent.length;
  var gOpenBefore = (window.__opened || []).length;
  gRow.querySelector('button.snd').click();
  await waitFor(function () { return window.__sent.length > gSentBefore; }, 12000);
  add('半自动在沟通页当场填草稿并发出（发的是这条岗位的草稿，不是上一条的旧文本）',
    window.__sent.length > gSentBefore && window.__sent[window.__sent.length - 1] === gText,
    JSON.stringify(String(window.__sent[window.__sent.length - 1]).slice(0, 20)) + ' vs ' + JSON.stringify(String(gText).slice(0, 20)));
  add('点的是文字为「发送」的真按钮，没误点「发送图片」上传控件（不再弹系统选图框）',
    window.__fileClicks === 0, 'fileClicks=' + window.__fileClicks);
  add('当前页就能发出去时不多开标签页', (window.__opened || []).length === gOpenBefore,
    'opened=' + (window.__opened || []).length);
  add('发送也不碰岗位卡片上的「立即沟通」', window.__greetClicks === greetB0 && window.__wrapClicks === wrapB0,
    JSON.stringify({ greet: window.__greetClicks - greetB0, wrap: window.__wrapClicks - wrapB0 }));
  await waitFor(function () { return ((window.__store.drafts || {})[gid] || {}).sent === true; }, 4000);
  add('半自动发成功后标记已发送并计数', ((window.__store.drafts || {})[gid] || {}).sent === true,
    JSON.stringify(window.__store.stats));
  add('沟通页里只认真正的聊天输入框：页面上那颗 VIP 兑换码 input 一个字都不沾',
    q('#vipCode').value === '', JSON.stringify(q('#vipCode').value.slice(0, 24)));

  // 半自动 · 情况二：当前页不是沟通页（没有输入框）。旧版这里只会甩一句「请先自己打开沟通页再点发送」，
  // 把最麻烦的一步推回给用户；而在面板这一页直接点「立即沟通」更危险 —— 收藏列表里每张卡片都有一颗，
  // 点错就把 A 岗位的话发给 B 的 HR，而且一点就整页跳走，面板连同这次 await 一起没了。
  // 现在的路：另开一个标签页走到「这个岗位」的沟通页，把话填好就停手，最后那一下留给用户点。
  q('#chatBox').style.display = 'none';
  q('#greetWrap').style.display = 'block';
  clickTab('queue');
  var hRow = all('#q_list .job').filter(function (r) { return r.querySelector('button.snd'); })[0];
  var hid = hRow.dataset.id;
  var hjob = (window.__store.jobs || []).filter(function (j) { return j.id === hid; })[0] || {};
  var hSentBefore = window.__sent.length;
  var hOpenBefore = (window.__opened || []).length;
  var greetB1 = window.__greetClicks, wrapB1 = window.__wrapClicks;
  hRow.querySelector('button.snd').click();
  var hOpened = await waitFor(function () { return (window.__opened || []).length > hOpenBefore; }, 8000);
  add('半自动：这一页不在沟通页时，脚本自己另开标签页走到这个岗位的沟通页',
    !!hOpened && window.__opened[window.__opened.length - 1] === hjob.url,
    String((window.__opened || []).slice(-1)[0]) + ' vs ' + hjob.url);
  add('不在用户这一页乱点「立即沟通」（面板页不会被整页带走）',
    window.__greetClicks === greetB1 && window.__wrapClicks === wrapB1,
    JSON.stringify({ greet: window.__greetClicks - greetB1, wrap: window.__wrapClicks - wrapB1 }));
  add('不在沟通页时，招呼语不会填进页面上随便一个输入框（图1 那颗 VIP 兑换码框保持空）',
    q('#vipCode').value === '', JSON.stringify(q('#vipCode').value.slice(0, 24)));
  var hDone = await waitFor(function () {
    var el = all('#q_list .job').filter(function (r) { return r.dataset.id === hid; })[0];
    return el && /已填待确认/.test(el.textContent);
  }, 20000);
  var hRow2 = all('#q_list .job').filter(function (r) { return r.dataset.id === hid; })[0];
  add('只填不发：这条岗位标成「已填待确认」而不是「已发送」', !!hDone,
    hRow2 ? (hRow2.querySelector('.st') || {}).textContent : '行没了');
  add('只填不发：这一页一条消息都没真的发出去', window.__sent.length === hSentBefore,
    'sent=' + window.__sent.length + ' / 之前 ' + hSentBefore);
  add('只填不发：不置 sent、不计数，「发送」按钮留着（用户点完还能再点一次变成功）',
    !((window.__store.drafts || {})[hid] || {}).sent && !!hRow2.querySelector('button.snd'),
    JSON.stringify(((window.__store.drafts || {})[hid] || {}).sent));
  add('半自动的发送请求用完就撤掉', !window.__store.sendReq, JSON.stringify(window.__store.sendReq));
  clickTab('log');
  var lgS = q('#bgLog').value;
  add('日志写清楚走了哪条路、以及最后一下要用户自己点',
    /只填不发/.test(lgS) && /已填好待你确认/.test(lgS),
    (lgS.match(/(另开标签页|已填好待你确认)[^\n]*/g) || ['无']).join(' | '));

  // 切全自动：单条「发送」必须自己开后台标签，不要求用户先切页面
  clickTab('log');
  var lgMark = q('#bgLog').value.length;   // 之后的日志才算「全自动阶段」
  clickTab('cfg');
  q('#m_auto').checked = true;
  q('#c_save2').click();
  await waitFor(function () { return window.__store.cfg && window.__store.cfg.autoSend === true; }, 1500);
  add('设置页切到全自动并落库', window.__store.cfg.autoSend === true, String(window.__store.cfg && window.__store.cfg.autoSend));
  clickTab('queue');
  add('队列页表头写明当前是全自动（不用去翻日志才知道跑的哪条路）', /全自动/.test(q('#bgBody').textContent),
    (q('#bgBody').textContent.match(/全自动|半自动/g) || ['无']).join(','));

  var openedBefore = (window.__opened || []).length;
  var taBefore = window.chatVal();
  var sentBefore = window.__sent.length;
  var wrapBefore = window.__wrapClicks;
  var uRow = all('#q_list .job').filter(function (r) { return r.querySelector('button.snd'); })[0];
  var uid = uRow.dataset.id;
  var ujob = (window.__store.jobs || []).filter(function (j) { return j.id === uid; })[0] || {};
  uRow.querySelector('button.snd').click();
  var opened = await waitFor(function () { return (window.__opened || []).length > openedBefore; }, 5000);
  add('全自动点「发送」后脚本自己开后台标签（不用再手动进沟通页）', !!opened, 'opened=' + (window.__opened || []).length);
  add('后台标签开的就是这条岗位的链接', !!opened && window.__opened[window.__opened.length - 1] === ujob.url,
    String((window.__opened || []).slice(-1)[0]) + ' vs ' + ujob.url);
  add('全自动不去动当前页的输入框', window.chatVal() === taBefore && window.__sent.length === sentBefore,
    JSON.stringify(window.chatVal().slice(0, 20)));
  add('全自动也不往当前页的普通输入框里填字（VIP 兑换码框仍是空的）',
    q('#vipCode').value === '', JSON.stringify(q('#vipCode').value.slice(0, 24)));
  await waitFor(function () { return ((window.__store.drafts || {})[uid] || {}).sent === true; }, 10000);
  add('后台标签回执成功后才标记已发送', ((window.__store.drafts || {})[uid] || {}).sent === true,
    JSON.stringify((window.__store.drafts || {})[uid]).slice(0, 60));
  add('发送请求用完就撤掉（不会留着，等用户下次自己打开这个岗位页时偷发一条）',
    !window.__store.sendReq, JSON.stringify(window.__store.sendReq));
  clickTab('log');
  var lg3 = q('#bgLog').value.slice(lgMark);
  add('日志写明走的是全自动开标签页发送', /全自动[^\n]*开标签页发送/.test(lg3), (lg3.match(/全自动[^\n]*/g) || ['无']).join(' | '));
  add('成功日志的模式标签跟设置一致（不再写死「半自动」）', /发送成功（全自动/.test(lg3) && !/发送成功（半自动/.test(lg3),
    (lg3.match(/发送成功（[^）]*）/g) || ['无']).join(' | '));

  // 后台标签那边点了发送但没清空：必须如实报失败，且不能标记已发送
  window.__tabMode = 'fail';
  clickTab('queue');
  var fRow = all('#q_list .job').filter(function (r) { return r.querySelector('button.snd'); })[0];
  var fid = fRow.dataset.id;
  fRow.querySelector('button.snd').click();
  await waitFor(function () { return /发送未确认/.test(q('#bgFoot').textContent); }, 12000);
  add('后台标签没发出去时如实报失败', /发送未确认/.test(q('#bgFoot').textContent), q('#bgFoot').textContent.slice(0, 70));
  add('没发出去就不标记已发送（不再假成功）', !((window.__store.drafts || {})[fid] || {}).sent,
    JSON.stringify(((window.__store.drafts || {})[fid] || {}).sent));
  var fRow2 = all('#q_list .job').filter(function (r) { return r.dataset.id === fid; })[0];
  add('失败后仍给「发送」按钮，允许重试', !!fRow2 && !!fRow2.querySelector('button.snd'), fRow2 ? '行在' : '行没了');

  // 后台标签压根没回执（登录墙/结构变了）：等满 60s 也要给出结论，不能一直转圈
  window.__tabMode = 'dead';
  var dRow = all('#q_list .job').filter(function (r) { return r.dataset.id === fid; })[0];
  dRow.querySelector('button.snd').click();
  await waitFor(function () { return /没回执/.test(q('#bgFoot').textContent); }, 78000);
  add('后台标签没回执时等到超时也给出明确结论', /没回执/.test(q('#bgFoot').textContent), q('#bgFoot').textContent.slice(0, 80));
  add('超时同样不标记已发送', !((window.__store.drafts || {})[fid] || {}).sent,
    JSON.stringify(((window.__store.drafts || {})[fid] || {}).sent));

  clickTab('queue');
  var sentRow = all('#q_list .job').filter(function (r) { return r.dataset.id === id0; })[0];
  add('已发送的草稿不再给「发送」按钮（防重复打扰同一个 HR）', !!sentRow && !sentRow.querySelector('button.snd'),
    sentRow ? sentRow.querySelectorAll('button').length + ' 个按钮 / 状态 ' + (sentRow.querySelector('.st') || {}).textContent : '行没了');
  // 状态徽章以前也叫 .snd，生产代码按 .snd 绑事件，于是点「已发送」这三个字会把这个岗位再发一遍
  var badge = sentRow ? sentRow.querySelector('.st') : null;
  var openedFinal = (window.__opened || []).length;
  var sentFinal = window.__sent.length;
  if (badge) badge.click();
  await new Promise(function (r) { setTimeout(r, 800); });
  add('点「已发送」状态徽章不会重发（class 不再和发送按钮撞）',
    !!badge && !/\bsnd\b/.test(badge.className) && (window.__opened || []).length === openedFinal && window.__sent.length === sentFinal,
    badge ? badge.className : '没徽章');
  add('全程没误点「发送图片」这类上传控件', window.__fileClicks === 0, String(window.__fileClicks));
  add('全程没误点到沟通按钮外面那层 wrap', window.__wrapClicks === wrapBefore, String(window.__wrapClicks));

  /* ===== 勾选才抓详情（v0.5.1 的自动路径：面板一直停在列表页，JD 从详情页回收） ===== */
  clickTab('cfg');
  q('#c_adet').checked = true;
  q('#m_semi').checked = true;      // 这一组验的是抓详情，先把模式退回半自动（下面点「生成」不该顺手发出去）
  q('#c_save2').click();
  await waitFor(function () { return window.__store.cfg && window.__store.cfg.autoFetchDetail === true; }, 2500);
  add('开关打开真的落库', window.__store.cfg.autoFetchDetail === true, String(window.__store.cfg.autoFetchDetail));
  add('切回半自动也真的落库', window.__store.cfg.autoSend === false, String(window.__store.cfg.autoSend));
  clickTab('queue');
  add('半自动下行内按钮只写「生成」，不写「并发送」（文案跟着模式走，不骗人）',
    all('#q_list .gen').length > 0 && all('#q_list .gen').every(function (b) { return !/并发送/.test(b.textContent); }),
    (all('#q_list .gen')[0] || {}).textContent);
  clickTab('jobs');
  var detOpenB1 = (window.__opened || []).length;
  q('#j_here').click();          // 4 条都已经抓到 JD 了：这一遍一条标签都不该再开
  await sleepMs(1500);
  add('JD 都已经在库里时，抓完列表不会重复开标签', (window.__opened || []).length === detOpenB1,
    '新增 ' + ((window.__opened || []).length - detOpenB1) + ' 个');
  clickTab('log');
  add('库里都有了就直说「不用重开标签」', /都已有详情，不用重开标签/.test(q('#bgLog').value),
    (q('#bgLog').value.match(/[^\n]*不用重开标签[^\n]*/g) || ['无'])[0]);

  // 新收藏/翻到底的感觉：往列表里再塞一张卡片。v0.5.1 起它默认不勾选，
  // 所以「抓完列表」这一步不该为它开标签；用户勾上它，才说明要处理这条，这时自动把 JD 捞回来。
  document.querySelector('.job-list-box').insertAdjacentHTML('beforeend',
    '<div class="job-card-wrap"><div class="job-card-body"><div class="info-primary">' +
    '<div class="job-name"><a class="job-title-link" href="https://www.zhipin.com/job_detail/eee555.html">Go 平台开发工程师</a></div>' +
    '<div class="salary-wrap"><span class="salary">30-50K·15薪</span></div>' +
    '<div class="company-wrap"><a class="company-name" href="https://www.zhipin.com/gongsi/sz.html">深圳某云厂商</a></div>' +
    '<div class="company-location">南山·科技园</div><div class="tag-list"><span>Go</span></div>' +
    '</div></div></div>');
  clickTab('jobs');
  var detOpenB2 = (window.__opened || []).length;
  var pendB2 = (window.__store.pendingDetails || []).length;
  var greetA0 = window.__greetClicks, wrapA0 = window.__wrapClicks;
  q('#j_here').click();
  await sleepMs(2500);
  var id4 = (window.__store.jobs || [])[4] ? (window.__store.jobs || [])[4].id : '';
  add('新抓到的第 5 条默认不勾选，抓完列表就不为它开标签（收藏列表里那些不打算发的岗位不再白抓）',
    (window.__store.jobs || []).length === 5 && (window.__store.jobs || [])[4].sel === false &&
    (window.__opened || []).length === detOpenB2,
    'jobs=' + (window.__store.jobs || []).length + ' sel=' + JSON.stringify((window.__store.jobs || [])[4] && (window.__store.jobs || [])[4].sel) +
    ' 新增标签 ' + ((window.__opened || []).length - detOpenB2));
  clickTab('queue');
  add('队列还是那 4 行：没勾的岗位不占队列', all('#q_list .job').length === 4, all('#q_list .job').length + ' 行');
  clickTab('jobs');
  var bx4 = all('#j_list input[type=checkbox]')[4];
  bx4.checked = true;
  bx4.dispatchEvent(new Event('change', { bubbles: true }));
  var aOpened = await waitFor(function () { return (window.__opened || []).length >= detOpenB2 + 1; }, 25000);
  var aUrls = (window.__opened || []).slice(detOpenB2);
  add('勾上它才自动开详情页（面板一直停在列表页，进详情页是脚本自己做的）',
    !!aOpened && aUrls.length === 1 && aUrls[0] === 'https://www.zhipin.com/job_detail/eee555.html', JSON.stringify(aUrls));
  add('待抓清单里记的是这条的 id + 详情页地址（后台标签靠它认出自己该抓哪个）',
    (window.__store.pendingDetails || []).slice(pendB2).map(function (p) { return p.id; }).join(',') === 'eee555',
    JSON.stringify((window.__store.pendingDetails || []).slice(pendB2)));
  add('自动抓详情这一步一颗沟通按钮都没点（不会把话发给错的 HR）',
    window.__greetClicks === greetA0 && window.__wrapClicks === wrapA0,
    JSON.stringify({ greet: window.__greetClicks - greetA0, wrap: window.__wrapClicks - wrapA0 }));
  clickTab('queue');
  var r4 = await waitFor(function () { var r = rowOf(id4); return r && r.querySelector('.gen'); }, 25000);
  add('新岗位 JD 回来后队列直接给「生成」（不会挂一个点了只会报错的按钮）', !!r4,
    r4 ? '' : '第五行还是补抓按钮');
  rowOf(id4).querySelector('.gen').click();
  var d4 = await waitFor(function () { var r = rowOf(id4); return r && r.querySelector('button.snd'); }, 20000);
  add('新岗位走的也是「先有 JD 再进模型」，提示词里是它自己那份详情',
    !!d4 && /JD-BG-eee555/.test(userPromptOf(lastReq())), userPromptOf(lastReq()).slice(0, 40));
  clickTab('log');
  add('日志说的「打开 1 个后台标签」和真实开出去的数量一致（不打空炮）',
    /打开 1 个后台标签抓详情/.test(q('#bgLog').value), (q('#bgLog').value.match(/打开 \d+ 个后台标签[^\n]*/g) || ['无']).join(' | '));

  /* ===== 发送路线 A（v0.5.0）：面板该开哪个标签页、走不通怎么自己退回 =====
   * 真实「列表页标签」里发生的事（认卡片 / 悬停 / 点它自己那颗沟通按钮 / 认会话）由
   * test/ui-listsend.html 八个 case 盯着；这一组只盯面板这一半：开对地址、via 标对、
   * 退回顺序对、失败不重复发。放在最后是因为它要两条「有草稿但没发出去」的岗位，
   * 前面那几组已经把 id0/id1/id3 发掉了，到这儿剩下的正好是「只填没发」那条 + 新抓的 eee555。 */
  clickTab('cfg');
  q('#c_listsend').checked = true;
  q('#m_auto').checked = true;      // 这一组验的是「全自动开标签页发送」，上面那组为了抓详情退回过半自动
  q('#c_save2').click();
  await waitFor(function () { return window.__store.cfg && window.__store.cfg.sendViaList === true; }, 1500);
  add('切回「优先列表卡片入口」落库（默认就是它，关掉能回老路）', window.__store.cfg.sendViaList === true,
    String(window.__store.cfg && window.__store.cfg.sendViaList));
  add('同时切回全自动', window.__store.cfg.autoSend === true, String(window.__store.cfg.autoSend));
  // 面板这一页是 file:// 的，而这条路要求 listUrl 是个真的列表页地址（老数据没记到就退回）。
  // 真实站点上抓取时记下来的就是 https，这里照那个形状填进去，验的是同一条判据。
  (window.__store.jobs || []).forEach(function (j) { j.listUrl = 'https://www.zhipin.com/web/geek/recommend?tab=4&tag=4'; });
  window.__tabMode = 'ok';
  window.__listTabMode = 'ok';
  clickTab('queue');
  var greetA1 = window.__greetClicks, wrapA1 = window.__wrapClicks, fileA1 = window.__fileClicks;
  var sndRows = all('#q_list .job').filter(function (r) { return r.querySelector('button.snd'); });
  add('备料：这一组要两条未发送草稿（一条验一次成功，一条验自动退回）', sndRows.length >= 2, sndRows.length + ' 条');
  var lid = sndRows[0].dataset.id, f2id = sndRows[1].dataset.id;
  var ljob = (window.__store.jobs || []).filter(function (j) { return j.id === lid; })[0] || {};
  var f2job = (window.__store.jobs || []).filter(function (j) { return j.id === f2id; })[0] || {};
  var lOpen0 = (window.__opened || []).length, lSent0 = window.__sent.length;
  window.__listReq = null;
  sndRows[0].querySelector('button.snd').click();
  var lOpened = await waitFor(function () { return (window.__opened || []).length > lOpen0; }, 8000);
  add('列表入口开的是那个列表页、URL 上带 #bgSend= 标记（不是岗位详情页）',
    !!lOpened && window.__opened[lOpen0] === ljob.listUrl + '#bgSend=' + String(lid).slice(0, 24),
    String((window.__opened || []).slice(lOpen0)[0]));
  add('交出去的请求写明 via=list，岗位详情页地址留着当退回用',
    !!window.__listReq && window.__listReq.via === 'list' && window.__listReq.jobUrl === ljob.url,
    JSON.stringify(window.__listReq || null).slice(0, 120));
  await waitFor(function () { return ((window.__store.drafts || {})[lid] || {}).sent === true; }, 12000);
  add('列表入口成功：只开这一个标签就到沟通页（少跑一趟详情页）',
    (window.__opened || []).length === lOpen0 + 1 && ((window.__store.drafts || {})[lid] || {}).sent === true,
    '新增 ' + ((window.__opened || []).length - lOpen0) + ' 个标签');
  add('面板这一页一个字都不发、一颗站点按钮都不点',
    window.__sent.length === lSent0 && window.__greetClicks === greetA1 && window.__wrapClicks === wrapA1,
    JSON.stringify({ sent: window.__sent.length - lSent0, greet: window.__greetClicks - greetA1, wrap: window.__wrapClicks - wrapA1 }));
  add('列表入口用完就把 sendReq / sendClaim 撤干净（用户之后自己开列表页不会被偷发）',
    !window.__store.sendReq && !window.__store.sendClaim,
    JSON.stringify({ req: window.__store.sendReq || null, claim: window.__store.sendClaim || null }));
  clickTab('log');
  add('日志写明这次走的是列表卡片入口', /列表卡片入口/.test(q('#bgLog').value),
    (q('#bgLog').value.match(/[^\n]*(列表卡片入口|岗位详情页入口)[^\n]*/g) || ['无']).slice(-1)[0]);

  // 这条路明确走不通（卡片在后面几页 / 已取消收藏）-> 自动退回老路子：用户不用管，也不能发两遍
  window.__listTabMode = 'fail';
  clickTab('log'); var lgB = q('#bgLog').value.length; clickTab('queue');
  var o2 = (window.__opened || []).length, s2 = window.__sent.length;
  var f2Row = rowOf(f2id);
  f2Row.querySelector('button.snd').click();
  var two = await waitFor(function () { return (window.__opened || []).length >= o2 + 2; }, 15000);
  add('列表入口走不通：先开列表页，再自动退回开岗位详情页（顺序对、两个都开对）',
    !!two && window.__opened[o2] === f2job.listUrl + '#bgSend=' + String(f2id).slice(0, 24) && window.__opened[o2 + 1] === f2job.url,
    JSON.stringify((window.__opened || []).slice(o2)).slice(0, 150));
  await waitFor(function () { return ((window.__store.drafts || {})[f2id] || {}).sent === true; }, 12000);
  add('退回之后照样发出去，而且这条只算一次（不会列表页一趟详情页一趟发两遍）',
    ((window.__store.drafts || {})[f2id] || {}).sent === true && window.__sent.length === s2,
    JSON.stringify({ sent: window.__sent.length - s2, stats: window.__store.stats }));
  clickTab('log');
  add('退回在日志里说得明白（用户看得见走的是哪条路）',
    /列表入口没走通/.test(q('#bgLog').value.slice(lgB)) && /退回岗位详情页入口/.test(q('#bgLog').value.slice(lgB)),
    (q('#bgLog').value.slice(lgB).match(/[^\n]*(没走通|退回)[^\n]*/g) || ['无']).join(' | ').slice(0, 90));
  add('退回这一步也没误点上传控件', window.__fileClicks === fileA1, String(window.__fileClicks - fileA1));

  /* ===== v0.5.1 收尾两件事：勾选才抓详情（连点并成一批）+ 全自动下「生成并发送」一步到位 =====
   * 放在最后：这组要新岗位、要两条「有 JD 但还没草稿」的岗位、还要临时改今日上限，
   * 前面那几组对队列行数和未发送草稿有依赖，别在中间动库存。
   * 用户提的现场：设置里明明选了全自动，在队列点「生成」之后还得自己再点一次「发送」
   * 才跳去沟通页 —— 和设置页那句「全自动：生成后自动开沟通页发送」对不上。
   */
  function addCard(href, title, company) {
    document.querySelector('.job-list-box').insertAdjacentHTML('beforeend',
      '<div class="job-card-wrap"><div class="job-card-body"><div class="info-primary">' +
      '<div class="job-name"><a class="job-title-link" href="' + href + '">' + title + '</a></div>' +
      '<div class="salary-wrap"><span class="salary">25-40K·14薪</span></div>' +
      '<div class="company-wrap"><a class="company-name" href="https://www.zhipin.com/gongsi/x.html">' + company + '</a></div>' +
      '<div class="company-location">南山·科技园</div><div class="tag-list"><span>Go</span></div>' +
      '</div></div></div>');
  }
  clickTab('jobs');
  addCard('https://www.zhipin.com/job_detail/fff666.html', '消息队列平台开发工程师', '杭州某基础设施公司');
  addCard('https://www.zhipin.com/job_detail/ggg777.html', '可观测性平台开发工程师', '杭州某云监控公司');
  var chkOpen0 = (window.__opened || []).length;
  q('#j_here').click();
  await sleepMs(2500);
  var jL = window.__store.jobs || [];
  var id5 = jL[5] ? jL[5].id : '', id6 = jL[6] ? jL[6].id : '';
  add('新抓的两条默认不勾选，抓完列表一条标签也不为它们开（不勾就是不处理）',
    jL.length === 7 && jL[5].sel === false && jL[6].sel === false && (window.__opened || []).length === chkOpen0,
    'jobs=' + jL.length + ' sel=' + JSON.stringify([jL[5] && jL[5].sel, jL[6] && jL[6].sel]) +
    ' 新增标签 ' + ((window.__opened || []).length - chkOpen0));
  // 连点两颗勾选框：防抖必须把它们并成一批，而不是勾一条起一轮
  var bx5 = all('#j_list input[type=checkbox]')[5];
  bx5.checked = true; bx5.dispatchEvent(new Event('change', { bubbles: true }));
  await sleepMs(300);
  var bx6 = all('#j_list input[type=checkbox]')[6];
  bx6.checked = true; bx6.dispatchEvent(new Event('change', { bubbles: true }));
  var twoOpened = await waitFor(function () { return (window.__opened || []).length >= chkOpen0 + 2; }, 25000);
  add('两次勾选并成一批开标签（攒一下一起开，不是勾一条起一轮）',
    !!twoOpened && (window.__opened || []).length === chkOpen0 + 2,
    '新增 ' + ((window.__opened || []).length - chkOpen0) + ' 个：' + JSON.stringify((window.__opened || []).slice(chkOpen0)));
  clickTab('log');
  add('日志里那一轮真的开了 2 个标签（数量说的是真开出去的）',
    /打开 2 个后台标签抓详情/.test(q('#bgLog').value),
    (q('#bgLog').value.match(/打开 \d+ 个后台标签[^\n]*/g) || ['无']).slice(-1)[0]);
  clickTab('queue');
  var bothJd = await waitFor(function () {
    var a = rowOf(id5), b = rowOf(id6);
    return !!(a && b && a.querySelector('.gen') && b.querySelector('.gen'));
  }, 40000);
  add('勾上之后 JD 自己回来，两行都换成普通按钮（用户不用回队列点第二次）', !!bothJd,
    bothJd ? '' : '还在等补抓按钮');
  add('全自动下这颗按钮写着「并发送」（点之前就知道它会发出去）',
    /并发送/.test(rowOf(id5).querySelector('.gen').textContent), rowOf(id5).querySelector('.gen').textContent);
  window.__listTabMode = 'ok';
  var gReq = genReqs().length, gOpen = (window.__opened || []).length, gSentLocal = window.__sent.length;
  rowOf(id5).querySelector('.gen').click();
  var gDone = await waitFor(function () { return ((window.__store.drafts || {})[id5] || {}).sent === true; }, 40000);
  add('全自动点一次「生成并发送」：没点第二下，这条就发出去了', !!gDone,
    gDone ? '' : JSON.stringify((window.__store.drafts || {})[id5] || null).slice(0, 70));
  add('生成确实进了模型（不是拿旧草稿直接发）', genReqs().length === gReq + 1, '新增 ' + (genReqs().length - gReq) + ' 条请求');
  add('走的还是全自动那条路：只开列表页那一个标签，面板这一页一个字都不发',
    (window.__opened || []).length === gOpen + 1 && window.__sent.length === gSentLocal,
    '新增标签 ' + ((window.__opened || []).length - gOpen) + ' / 本页发出 ' + (window.__sent.length - gSentLocal));

  // 今日上限：批量在发之前拦，单条「生成并发送」也得拦（半自动最后那一下是用户自己点的，不替他拦）
  clickTab('cfg');
  var dayCap0 = (window.__store.cfg || {}).maxPerDay;
  q('#c_max').value = String((window.__store.stats || {}).sent || 1);
  q('#c_save2').click();
  await waitFor(function () { return window.__store.cfg && Number(window.__store.cfg.maxPerDay) <= Number((window.__store.stats || {}).sent); }, 2500);
  clickTab('queue');
  var cOpen = (window.__opened || []).length, cSent = (window.__store.stats || {}).sent, cReq = genReqs().length;
  rowOf(id6).querySelector('.gen').click();
  var cDone = await waitFor(function () { return /已达今日发送上限/.test(q('#bgFoot').textContent); }, 30000);
  add('到上限后不再自动发送：草稿照生成，但不碰沟通页、不计数',
    !!cDone && genReqs().length === cReq + 1 && !!draftOf(id6) && draftOf(id6).sent !== true &&
    (window.__opened || []).length === cOpen && Number((window.__store.stats || {}).sent) === cSent,
    JSON.stringify({ 请求: genReqs().length - cReq, 标签: (window.__opened || []).length - cOpen, 已发: (window.__store.stats || {}).sent }));
  clickTab('log');
  add('上限这条说得清下一步该怎么办', /已达今日发送上限/.test(q('#bgLog').value) && /重置今日计数/.test(q('#bgLog').value),
    (q('#bgLog').value.match(/已达今日发送上限[^\n]*/g) || ['无']).slice(-1)[0]);
  clickTab('cfg');
  q('#c_max').value = String(dayCap0 || 20);
  q('#c_save2').click();
  await waitFor(function () { return window.__store.cfg && Number(window.__store.cfg.maxPerDay) >= 20; }, 2500);

  /* ============ v0.5.2：生成并起来跑，发送仍然逐条排队 ============ */
  // 并发只加在「打到自己模型服务」那一段，站点看到的节奏一点没变。
  // 响应故意拖慢（window.__genDelay）：不拖的话每条请求瞬间就回来，「同时在飞」压不到 2，
  // 「并发真的起来了」这条断言会永远为真 —— 等于没测。
  window.__genDelay = 700;
  function undrafted() {
    clickTab('queue');
    return all('#q_list .job').filter(function (r) {
      return r.querySelector('.gen') && !draftOf(r.dataset.id);   // 有 JD、没草稿：批量才会真的进模型
    });
  }
  async function dropDrafts(n) {
    var ids = [];
    for (var k = 0; k < n; k++) {
      clickTab('queue');
      var pool = all('#q_list .job').filter(function (r) {
        return r.querySelector('.gen') && ids.indexOf(r.dataset.id) < 0;    // 有 JD、这轮还没要过
      });
      var row = pool.filter(function (r) { return !draftOf(r.dataset.id); })[0] ||
                pool.filter(function (r) { var d = draftOf(r.dataset.id); return d && !d.sent; })[0];
      if (!row) break;
      var wid = row.dataset.id;
      if (draftOf(wid)) {
        row.querySelector('.drop').click();      // 丢完会重画队列，所以每轮重新按条件找行
        await waitFor(function () { return !draftOf(wid); }, 4000);
      }
      ids.push(wid);
    }
    return ids;
  }
  function setCfg(semi, concVal) {
    clickTab('cfg');
    q(semi ? '#m_semi' : '#m_auto').checked = true;
    if (concVal !== undefined) q('#c_conc').value = String(concVal);
    q('#c_max').value = '60';                    // 这一组要真的发好几条，别让今日上限插一脚
    q('#c_save2').click();
    return waitFor(function () {
      var c = window.__store.cfg || {};
      return c.autoSend === !semi && Number(c.maxPerDay) === 60 &&
        (concVal === undefined || Number(c.genConcurrency) === concVal);
    }, 3000);
  }

  // 备料：并发要「同时在飞」才看得出，前面几轮把队列里的草稿都消耗光了，
  // 所以再抓 4 张新卡片进来（岗位页默认不勾选 → 逐条勾上才会去后台抓 JD → 才有可生成的岗位）。
  clickTab('cfg');
  q('#c_adet').checked = true;
  q('#c_save2').click();
  await waitFor(function () { return (window.__store.cfg || {}).autoFetchDetail === true; }, 3000);
  clickTab('jobs');
  addCard('https://www.zhipin.com/job_detail/hhh888.html', '分布式存储研发工程师', '武汉某存储公司');
  addCard('https://www.zhipin.com/job_detail/iii999.html', '高性能计算工程师', '苏州某算力公司');
  addCard('https://www.zhipin.com/job_detail/jjj000.html', '云原生平台开发工程师', '南京某云公司');
  addCard('https://www.zhipin.com/job_detail/kkk111.html', '数据库内核开发工程师', '成都某数据库公司');
  q('#j_here').click();
  await sleepMs(2200);
  var bxNew = all('#j_list input[type=checkbox]');
  var nJob = (window.__store.jobs || []).length;
  for (var z = nJob - 4; z < nJob; z++) { bxNew[z].checked = true; bxNew[z].dispatchEvent(new Event('change', { bubbles: true })); }
  var got4 = await waitFor(function () { return undrafted().length >= 4; }, 60000);
  add('备料成功：4 条新岗位勾上后 JD 自己回来、且都还没有草稿', !!got4,
    undrafted().length + ' 条可生成 / 岗位共 ' + nJob);

  // ① 半自动下并发：只谈生成，别把发送搅进来
  var okSemi = await setCfg(true, 3);
  add('设置页能把「并发生成数」落库（不是个装饰数字）', !!okSemi,
    JSON.stringify({ conc: (window.__store.cfg || {}).genConcurrency, auto: (window.__store.cfg || {}).autoSend }));
  var parIds = undrafted().map(function (r) { return r.dataset.id; });
  window.__inflight = 0; window.__peakInflight = 0; window.__dupGen = 0;
  var tReq = genReqs().length;
  clickTab('queue');
  q('#q_run').click();
  var tEnd = await waitFor(function () { return /批量任务结束/.test(q('#bgFoot').textContent); }, 60000);
  add('并发真的起来了：同一时刻有多条大模型请求在飞（串行时这个数永远是 1）',
    !!tEnd && parIds.length >= 3 && window.__peakInflight >= 2,
    '峰值在飞 ' + window.__peakInflight + ' 路 / 设置 3 路 / 待生成 ' + parIds.length + ' 条');
  add('也没越过设置那道闸（服务商报 429 时用户能自己把并发调小）',
    window.__peakInflight <= 3, '峰值 ' + window.__peakInflight + ' 已越过设置的 3');
  add('一条岗位只发一次请求：并发生成不许白烧 token',
    window.__dupGen === 0, '同一份提示词重复在飞 ' + window.__dupGen + ' 次');
  add('待生成的每条都真的进了模型一次（新增请求数对得上岗位数）',
    genReqs().length >= tReq + parIds.length,
    JSON.stringify({ 新增请求: genReqs().length - tReq, 岗位: parIds.length }));
  add('并发跑完的草稿一条都不少（提速不许丢岗位）',
    parIds.every(function (tid) { return !!draftOf(tid); }),
    parIds.length + ' 条 / 有草稿 ' + parIds.filter(function (t) { return !!draftOf(t); }).length + ' 条');
  clickTab('log');
  add('日志说清这一轮并了几路、并写明发送仍然排队',
    /并发生成 3 路/.test(q('#bgLog').value) && /发送仍逐条排队/.test(q('#bgLog').value),
    (q('#bgLog').value.match(/本轮 \d+ 个岗位[^\n]*/g) || ['无']).slice(-1)[0]);

  // ② 这个数字必须关得掉：调回 1 就退回逐条
  await setCfg(true, 1);
  var twoIds = await dropDrafts(2);
  window.__inflight = 0; window.__peakInflight = 0;
  clickTab('queue');
  q('#q_run').click();
  var oEnd = await waitFor(function () { return /批量任务结束/.test(q('#bgFoot').textContent); }, 60000);
  add('把并发生成数调回 1 就真的退回逐条（数字不是摆设）',
    !!oEnd && twoIds.length >= 2 && window.__peakInflight <= 1, '峰值在飞 ' + window.__peakInflight + ' 路');

  // ③ 上限要钳住：手输 99 不许把服务商打爆，留空不许存成 NaN（0 路 = 批量永远不动）
  await setCfg(true, 99);
  add('并发生成数被钳在 8 以内（手输 99 也不会一路 429）',
    Number((window.__store.cfg || {}).genConcurrency) === 8, JSON.stringify((window.__store.cfg || {}).genConcurrency));
  clickTab('cfg');
  q('#c_conc').value = '';
  q('#m_semi').checked = true;
  q('#c_max').value = '60';
  q('#c_save2').click();
  await waitFor(function () { return Number((window.__store.cfg || {}).genConcurrency) === 3; }, 3000);
  add('留空退回默认 3，不会存成 NaN 把并发算成 0 路（那样批量就一步都不走）',
    Number((window.__store.cfg || {}).genConcurrency) === 3, JSON.stringify((window.__store.cfg || {}).genConcurrency));

  // ④ 最要紧的一条：并发只许加在生成上，发送必须还是逐条
  window.__sendOverlap = 0;
  await setCfg(false, 3);
  clickTab('queue');
  var sOpen = (window.__opened || []).length;
  var sndRows = all('#q_list .job').filter(function (r) { return !!r.querySelector('button.snd'); }).length;
  add('全自动这一组备到至少 2 条待发草稿', sndRows >= 2, sndRows + ' 行有「发送」按钮');
  // 回执必须拖到比发送间隔（这一组是 2 秒）还长：真实站点那一跳本来就要好几秒。
  // 回执秒回时，消费者哪怕不 await 也撞不上车（上一条已经销毁了），这条「发送必须逐条」
  // 就成了永远为真的断言 —— 拖慢之后它才真的能红（把消费者里的 await sendOne(id) 改成不 await 验过，会红）。
  window.__sendDelay = 3000;
  q('#q_run').click();
  var sEnd = await waitFor(function () { return /批量任务结束/.test(q('#bgFoot').textContent); }, 90000);
  add('发送仍然逐条：上一条 sendReq 没销毁就绝不写下一条（两条同时在飞 = 谁都没法确认发没发出去）',
    !!sEnd && window.__sendOverlap === 0, '两条发送重叠 ' + window.__sendOverlap + ' 次');
  add('逐条发送真的照草稿走完了（并发没把发送这一步挤掉）',
    (window.__opened || []).length > sOpen, '新增后台标签 ' + ((window.__opened || []).length - sOpen));
  window.__sendDelay = 0;

  // ⑤ 并发把「同时在飞」变成常态，于是同一条岗位被两路同时处理也变常见了：
  // 批量正在写这一条、用户又手点了同一行 —— 只能有一条请求、一条消息（否则同一个 HR 收到两遍同样的话）。
  // 备料：上面几轮把未发送草稿都消耗光了（已发送的草稿脚本故意不让丢），所以再抓一条新岗位进来。
  window.__genDelay = 900;
  await setCfg(false, 3);
  clickTab('jobs');
  addCard('https://www.zhipin.com/job_detail/lll222.html', '风控系统开发工程师', '广州某风控公司');
  q('#j_here').click();
  await sleepMs(2200);
  var bxF = all('#j_list input[type=checkbox]');
  var nF = (window.__store.jobs || []).length;
  bxF[nF - 1].checked = true; bxF[nF - 1].dispatchEvent(new Event('change', { bubbles: true }));
  await waitFor(function () { return undrafted().length >= 1; }, 60000);
  var dRow = undrafted()[0];
  add('手点合流这一步备到一条「有 JD 且没草稿」的岗位', !!dRow, dRow ? dRow.dataset.id : '没有可点的行');
  if (dRow) {
    var dId = dRow.dataset.id;
    var dReq = genReqs().length, dOpen = (window.__opened || []).length;
    var dDup = window.__dupGen, dOv = window.__sendOverlap;
    rowOf(dId).querySelector('.gen').click();
    var again = rowOf(dId);
    if (again && again.querySelector('.gen')) again.querySelector('.gen').click();   // 请求还在飞，再点一次
    var dDone = await waitFor(function () { return ((window.__store.drafts || {})[dId] || {}).sent === true; }, 60000);
    add('同一行连点两次只发一条大模型请求（同一条岗位在飞时合流，不重复烧 token）',
      !!dDone && genReqs().length === dReq + 1 && window.__dupGen === dDup,
      '新增 ' + (genReqs().length - dReq) + ' 条请求 / 重复在飞 ' + (window.__dupGen - dDup) + ' 次');
    add('也只开一个后台标签、只写一条 sendReq（同一个 HR 不会收到两遍同样的话）',
      (window.__opened || []).length === dOpen + 1 && window.__sendOverlap === dOv,
      JSON.stringify({ 新增标签: (window.__opened || []).length - dOpen, 发送重叠: window.__sendOverlap - dOv }));
  }
  window.__genDelay = 0;

  // ⑥ 用户实测反馈：批量跑到一半他在面板里切来切去，回来发现「生成中」掉回「待处理」、日志也空了。
  //   切标签只重建 #bgBody，批量循环活在 JS 上下文里 —— 这两条断言钉住「不该被打断」。
  // 备料：前面几轮的草稿都还在（已发送的不许丢），所以照 ⑤ 的办法再抓 3 条新岗位进来。
  window.__genDelay = 1500;
  await setCfg(true, 3);
  clickTab('jobs');
  addCard('https://www.zhipin.com/job_detail/mmm333.html', '中间件平台开发工程师', '杭州某中间件公司');
  addCard('https://www.zhipin.com/job_detail/nnn444.html', '可观测性平台开发工程师', '北京某可观测公司');
  addCard('https://www.zhipin.com/job_detail/ooo555.html', '消息队列研发工程师', '深圳某消息队列公司');
  q('#j_here').click();
  await sleepMs(2200);
  var bxSw = all('#j_list input[type=checkbox]');
  var nSw = (window.__store.jobs || []).length;
  for (var y = nSw - 3; y < nSw; y++) { bxSw[y].checked = true; bxSw[y].dispatchEvent(new Event('change', { bubbles: true })); }
  await waitFor(function () { return undrafted().length >= 3; }, 60000);
  var swIds = undrafted().map(function (r) { return r.dataset.id; });
  clickTab('queue');
  var swReq = genReqs().length;
  q('#q_run').click();
  await sleepMs(700);
  var midGen = all('#q_list .st').filter(function (r) { return (r.textContent || '').indexOf('生成中') >= 0; }).length;
  add('切标签这一步确实备到了「正在生成中」的行', midGen >= 1 && swIds.length >= 2,
    midGen + ' 行生成中 / 备好 ' + swIds.length + ' 条');
  clickTab('cfg'); await sleepMs(500);
  clickTab('log'); await sleepMs(500);
  clickTab('queue');
  var swEnd = await waitFor(function () { return /批量任务结束/.test(q('#bgFoot').textContent); }, 60000);
  add('在面板里切来切去不许打断批量（该生成的草稿一条不少）',
    !!swEnd && swIds.every(function (sid) { return !!draftOf(sid); }),
    JSON.stringify({ 结束: !!swEnd, 有草稿: swIds.filter(function (sid) { return !!draftOf(sid); }).length, 共: swIds.length }));
  add('切回来徽章仍是「已生成/待确认」，不掉回「待处理」（内存态不跟着 DOM 一起重建）',
    swIds.every(function (sid) {
      var r = rowOf(sid);
      return r && /已生成|待确认/.test(((r.querySelector('.st') || {}).textContent) || '');
    }),
    swIds.map(function (sid) { var r = rowOf(sid); return r ? ((r.querySelector('.st') || {}).textContent) : '行没了'; }).join(' / '));
  add('每条都真的进了模型，切标签没让谁半路退出',
    genReqs().length >= swReq + swIds.length,
    '新增 ' + (genReqs().length - swReq) + ' 条请求 / 岗位 ' + swIds.length + ' 条');
  clickTab('log');
  add('日志不会被切标签清空（本轮那几行还在）',
    /并发生成 3 路/.test(q('#bgLog').value) && /批量任务结束/.test(q('#bgLog').value),
    (q('#bgLog').value.split(String.fromCharCode(10)).filter(function (L) { return /本轮|批量任务结束/.test(L); }).pop() || '无'));
  window.__genDelay = 0;

  // ⑦ 真凶是「换页面」：BOSS 的列表页/详情页之间就是整页跳转，那一跳会把这一页的 JS 上下文整个销毁 ——
  //   批量循环、队列状态、内存里的 logBuf 全跟着没。用户看到的就是「生成中退回待处理 + 日志清空」，
  //   而 ⑥ 已经证明面板里切标签不会这样（循环活在内存里）。所以这里钉另一半：计划要落盘、新页面要接得上。
  //   真的 reload 会把断言一起冲掉，所以照本项目的老办法造「新页面」：把 .user.js 原文再执行一遍
  //   —— 新执行 = 新闭包（states / logBuf / runner / 循环全是新的），只有油猴存储 window.__store 是共享的，
  //   和真跳转的唯一区别是旧上下文的定时器杀不掉。因此每一步只让「该动的那一页」有条件动：
  //   A 页（跑批量这一页）把「自动接着跑」关掉，B 页只验手动「继续」，C 页才验自动接管。
  async function stuckJobs(n, tag) {   // 造 n 条「有 JD、没草稿」的岗位
    clickTab('jobs');
    for (var k = 0; k < n; k++) {
      addCard('https://www.zhipin.com/job_detail/' + tag + k + '.html', '岗位' + tag + k + '号', '某' + tag + '公司');
    }
    q('#j_here').click();
    await sleepMs(2200);
    var bx = all('#j_list input[type=checkbox]');
    var tot = (window.__store.jobs || []).length;
    for (var z = tot - n; z < tot; z++) { bx[z].checked = true; bx[z].dispatchEvent(new Event('change', { bubbles: true })); }
    await waitFor(function () { return undrafted().length >= n; }, 60000);
    return undrafted().slice(0, n).map(function (r) { return r.dataset.id; });
  }
  function reboot() {   // 模拟「跳到别的页面，那一页重新加载脚本」
    [].slice.call(document.querySelectorAll('#bgPanel,#bgMin')).forEach(function (el) { el.remove(); });
    (0, eval)(document.getElementById('bgSrc').textContent);
    return waitFor(function () {
      return q('#bgStat') && /可续跑|批量进行中/.test(q('#bgStat').textContent) ||
        (q('#bgFoot') && /面板已就绪/.test(q('#bgFoot').textContent));
    }, 12000);
  }
  var day0 = new Date().toISOString().slice(0, 10);

  // —— A 页：正在跑的时候，计划长什么样、离开页面拦不拦
  window.__genDelay = 30000000;          // 慢到等于永不返回：这几条会一直停在「生成中」
  await setCfg(true, 3);
  clickTab('cfg');
  q('#c_resume').checked = false;        // A 页自己不接管（旧上下文的定时器杀不掉，只能这么隔离）
  q('#c_save2').click();
  await waitFor(function () { return (window.__store.cfg || {}).autoResume === false; }, 4000);
  var aIds = await stuckJobs(3, 'aaa');
  var ev0 = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(ev0);
  add('没在跑批量时不许拦用户离开（beforeunload 不能变成常驻弹窗）', !ev0.defaultPrevented, '');
  clickTab('queue');
  q('#q_run').click();
  var sawPlan = await waitFor(function () {
    var p = window.__store.bgBatch; return p && p.ids && aIds.every(function (id) { return p.ids.indexOf(id) >= 0; });
  }, 10000);
  var pRun = JSON.parse(JSON.stringify(window.__store.bgBatch || {}));
  add('批量一开跑就把「这一轮要跑哪几条」写进油猴存储（页面一销毁，内存里的循环就只剩它了）',
    !!sawPlan && pRun.day === day0, JSON.stringify(pRun));
  var tick0 = Number(pRun.tick);
  await sleepMs(5000);                        // 这一页还在跑，心跳得一直续
  var pBeat = window.__store.bgBatch || {};
  add('跑着的时候这一页在续心跳（别的页面靠它判断「这计划还有人认领」，不能抢）',
    !!pRun.by && Number(pBeat.tick) > tick0 && pBeat.by === pRun.by,
    'tick ' + tick0 + ' → ' + pBeat.tick + '（走 ' + (Number(pBeat.tick) - tick0) + 'ms）/ by 不变 ' + (pBeat.by === pRun.by));
  add('顶部看得见「批量进行中 剩 X/Y」（不再只是默默退回待处理）',
    /批量进行中/.test(q('#bgStat').textContent), q('#bgStat').textContent);
  add('批量正在跑时离开这一页会被拦一道（误点别的页面 = 当场打断，得先问一句）',
    (function () { var ev = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(ev); return ev.defaultPrevented; })(), '');
  add('日志同时在往油猴存储写副本（整页跳转销毁的是内存里那份 logBuf）',
    Array.isArray(window.__store.bgLogBuf) && /并发生成 3 路/.test(window.__store.bgLogBuf.join(' | ')),
    (window.__store.bgLogBuf || []).length + ' 行');
  q('#q_run').click();                   // 停止批量
  var parked = await waitFor(function () {
    var p = window.__store.bgBatch; return p && p.by === '';
  }, 30000);
  add('「停止批量」之后计划留在存储里、标成没人认领（这是用户自己停的，别的页面不许自动接着跑）',
    !!parked, JSON.stringify(window.__store.bgBatch));
  // 心跳也断够久（当这一页已经没了）：这样 A 页「不自动」只可能是「自动接着跑」那道开关拦的，
  // B 页「不自动」只可能是「没人认领」拦的 —— 两道闸各管各的，别互相盖住。
  if (window.__store.bgBatch) window.__store.bgBatch.tick = Date.now() - 90000;
  clickTab('queue');
  var nResume = Number(((q('#q_resume') || {}).textContent || '').match(/\d+/) ? q('#q_resume').textContent.match(/\d+/)[0] : 0);
  add('停下来队列页就把话说清：挂着「继续上次批量（剩 N 条）」，而且确实把这 3 条算在剩里',
    !!q('#q_resume') && nResume >= 3 && aIds.every(function (id) { return !draftOf(id); }),
    q('#q_resume') ? q('#q_resume').textContent : '没这颗按钮');
  var reqPark = genReqs().length;
  await sleepMs(7000);
  add('关掉「页面跳转后自动接着跑」就真的不自动：A 页守着计划 7 秒，一条请求都没多发',
    genReqs().length === reqPark, '新增 ' + (genReqs().length - reqPark) + ' 条');

  // —— B 页：用户跳到别的页面又回来（新上下文 + 同一份存储）
  window.__genDelay = 0;
  window.__store.cfg = Object.assign({}, window.__store.cfg, { autoResume: true });   // 只给下一页打开
  var bootedB = await reboot();
  add('跳转后重新加载的这一页照样起得来面板（脚本认得存储里已有的岗位和草稿）',
    !!bootedB && (window.__store.jobs || []).length >= 3, JSON.stringify({ 岗位: (window.__store.jobs || []).length }));
  clickTab('log');
  add('整页跳转后日志不会一片空白：上一页那几行从存储里接回来了',
    /这一轮还剩 \d+ 条没跑完/.test(q('#bgLog').value) && /面板已就绪/.test(q('#bgLog').value),
    (q('#bgLog').value.split(String.fromCharCode(10)).filter(function (L) { return /没跑完|面板已就绪/.test(L); }).join(' | ') || '空的'));
  clickTab('queue');
  var nSeen = Number((q('#bgStat').textContent.match(/可续跑 (\d+) 条/) || [0, 0])[1]);
  add('新页面认得出「上一轮没跑完」：顶部写「可续跑 N 条」，队列页有那颗按钮',
    nSeen >= 3 && !!q('#q_resume'), q('#bgStat').textContent);
  var reqB = genReqs().length;
  await sleepMs(7000);
  add('这一轮是用户自己停的（计划没人认领）→ 新页面绝不自动开跑，只能他点「继续」',
    genReqs().length === reqB, '新增 ' + (genReqs().length - reqB) + ' 条');
  q('#q_resume').click();
  var bEnd = await waitFor(function () { return /批量任务结束/.test(q('#bgFoot').textContent); }, 60000);
  add('点「继续上次批量」真的把剩下的接上跑完（该生成的草稿一条不少）',
    !!bEnd && aIds.every(function (id) { return !!draftOf(id); }),
    JSON.stringify({ 结束: !!bEnd, 有草稿: aIds.filter(function (id) { return !!draftOf(id); }).length }));
  add('续跑只补没做完的那几条（新增请求数就等于它说的那个数），跑完计划就从存储里撤掉',
    genReqs().length === reqB + nSeen && !window.__store.bgBatch,
    '新增 ' + (genReqs().length - reqB) + ' 条请求 / 按钮说 ' + nSeen + ' 条 / 计划 ' + JSON.stringify(window.__store.bgBatch || null));

  // —— C 页：真的「跑到一半被整页跳转打断」的现场（计划带着心跳，但心跳断了）
  clickTab('cfg');
  q('#c_resume').checked = false;        // B 页也别自动接管，把「接管」这件事单独留给 C
  q('#c_save2').click();
  await waitFor(function () { return (window.__store.cfg || {}).autoResume === false; }, 4000);
  window.__genDelay = 30000000;
  var cIds = await stuckJobs(3, 'ccc');
  window.__genDelay = 0;
  // 按 A 页跑着时实测到的那份形状（上面断言钉过），造一份「心跳断掉的死页计划」
  window.__store.bgBatch = { ids: cIds, autoSend: false, day: day0, tick: Date.now(), by: pRun.by };
  window.__store.cfg = Object.assign({}, window.__store.cfg, { autoResume: true });
  var bootedC = await reboot();
  var reqC = genReqs().length;
  await sleepMs(7000);
  add('心跳还新鲜（可能另一页真在跑）→ 新页面不许抢同一份计划，先等着',
    !!bootedC && genReqs().length === reqC, '新增 ' + (genReqs().length - reqC) + ' 条');
  window.__store.bgBatch.tick = Date.now() - 90000;      // 心跳断了 90 秒：那一页确实已经没了
  var cTook = await waitFor(function () { return /自动接着跑|批量任务结束/.test(q('#bgFoot').textContent); }, 30000);
  var cEnd = await waitFor(function () {
    return cIds.every(function (id) { return !!draftOf(id); }) && /批量任务结束/.test(q('#bgFoot').textContent);
  }, 90000);
  add('心跳断了（页面被整页跳转销毁）→ 新页面自动把剩下 3 条接着跑完，用户不用再点',
    !!cTook && !!cEnd, JSON.stringify({ 接管: !!cTook, 有草稿: cIds.filter(function (id) { return !!draftOf(id); }).length }));
  add('自动接管也只发该发的 3 条，做完就撤计划',
    genReqs().length === reqC + 3 && !window.__store.bgBatch,
    '新增 ' + (genReqs().length - reqC) + ' 条请求 / 计划 ' + JSON.stringify(window.__store.bgBatch || null));
  clickTab('log');
  add('接管这件事会在日志里说清是哪一轮被跳转打断的',
    /被页面跳转打断/.test(q('#bgLog').value),
    (q('#bgLog').value.split(String.fromCharCode(10)).filter(function (L) { return /页面跳转/.test(L); }).pop() || '没有这行'));

  // —— D 页：把「自动接着跑」关上之后，连「有人认领 + 心跳断了」这种该接管的现场也不许自己开跑
  clickTab('cfg');
  q('#c_resume').checked = false;        // 先把 C 页也关了，免得它抢在 D 页之前动
  q('#c_save2').click();
  await waitFor(function () { return (window.__store.cfg || {}).autoResume === false; }, 4000);
  window.__genDelay = 30000000;
  var dIds = await stuckJobs(3, 'ddd');
  window.__genDelay = 0;
  window.__store.bgBatch = { ids: dIds, autoSend: false, day: day0, tick: Date.now() - 90000, by: pRun.by };
  var bootedD = await reboot();
  var reqD = genReqs().length;
  await sleepMs(7000);
  add('设置里关上「页面跳转后自动接着跑」：该接管的现场也绝不自己开跑，计划原样挂着',
    !!bootedD && genReqs().length === reqD && (window.__store.bgBatch || {}).by === pRun.by,
    '新增 ' + (genReqs().length - reqD) + ' 条 / 计划 ' + JSON.stringify(window.__store.bgBatch || null));
  clickTab('queue');
  add('关上时新页面仍然把话说清：顶部「可续跑 N 条」+ 队列页那颗按钮，用户点一下才动',
    /可续跑 \d+ 条/.test(q('#bgStat').textContent) && !!q('#q_resume'), q('#bgStat').textContent);
  clickTab('jobs'); q('#j_here').click();      // 这一页自己打一行新的（没在跑批量，也就没有心跳）
  var flushedD = await waitFor(function () {
    var last = (window.__store.bgLogBuf || []).slice(-1)[0] || '';
    return !!last && last === (q('#bgFoot').textContent || '');
  }, 8000);
  add('不在跑批量时（没心跳）日志也照样往存储写：这一页最新那行，就是存储副本里最新那行',
    !!flushedD,
    '存储末尾: ' + String((window.__store.bgLogBuf || []).slice(-1)[0] || '空') + ' / 本页末尾: ' + q('#bgFoot').textContent);

  // 续跑的账本也得认持久凭证：那一轮里真发出去过的岗位，不该再算成「还剩几条」
  window.__store['bgSent:' + dIds[0]] = { at: Date.now(), href: 'https://www.zhipin.com/web/chat/index' };
  clickTab('queue');
  await waitFor(function () { return /可续跑 2 条/.test(q('#bgStat').textContent); }, 8000);
  add('挂着持久凭证的那条不再算进「可续跑 N 条」：已经发出去的就是发出去了',
    /可续跑 2 条/.test(q('#bgStat').textContent), q('#bgStat').textContent);
  var reqD2 = genReqs().length;
  q('#q_resume').click();
  var dEnd = await waitFor(function () { return /批量任务结束/.test(q('#bgFoot').textContent); }, 90000);
  add('点「继续」只补做没凭证的那 2 条，有凭证那条一个字都没再发、也没被顺手生成，跑完撤计划',
    !!dEnd && genReqs().length === reqD2 + 2 && !draftOf(dIds[0]) && !window.__store.bgBatch,
    JSON.stringify({ 新增请求: genReqs().length - reqD2, 凭证那条有草稿: !!draftOf(dIds[0]), 计划: window.__store.bgBatch || null }));

  // 「清空列表」要是只清草稿、留下「已发出」凭证，重抓同一批岗位就会被「在上一页就已经发出去了」
  // 拦住 —— 用户怎么点都发不出去，还以为脚本坏了。这两个必须一起扫。
  window.__store.bgBatch = { ids: [dIds[1]], autoSend: false, day: day0, tick: Date.now() - 90000, by: 'x' };
  var credBefore = !!window.__store['bgSent:' + dIds[0]];
  var planBefore = !!window.__store.bgBatch;
  clickTab('jobs');
  window.confirm = function () { return true; };
  q('#j_clear').click();
  var clearedAll = await waitFor(function () {
    return !window.__store['bgSent:' + dIds[0]] && !window.__store.bgBatch && (window.__store.jobs || []).length === 0;
  }, 5000);
  add('「清空列表」把「已发出」凭证和批量计划跟草稿一起扫掉（不留两个互相矛盾的真相）',
    credBefore && planBefore && !!clearedAll,
    JSON.stringify({ 清前凭证: credBefore, 凭证: window.__store['bgSent:' + dIds[0]] || null, 计划: window.__store.bgBatch || null, 岗位: (window.__store.jobs || []).length }));
  clickTab('log');
  add('扫掉几条凭证这件事在日志里说清（用户才知道重抓同一批可以再发）',
    /条「已发出」凭证/.test(q('#bgLog').value),
    (q('#bgLog').value.split(String.fromCharCode(10)).filter(function (L) { return /清空/.test(L); }).pop() || '没有这行'));

  // ⑧ 一整块回写会把别的标签页踩掉 —— 用户实测的「跳一次页面，草稿全变待处理」就是这个。
  //   bgDrafts / bgJobs / stats 在存储里各是**一整块**，每个标签页 boot 时读走自己那份内存快照，
  //   之后所有改动都往整块上盖：谁后写，谁就把别人在这期间新增的记录连锅端掉。
  //   他同时开着好几个 BOSS 标签页，跳页面时接上的是「早就开着」的那一页 —— 它手里那份快照
  //   是这些草稿生成之前的，于是 planLeft 把做完的又算成「还剩 10/11 条」，回写时把别人写好的抹平。
  //   下面三段分别钉：抓一次列表不能端掉别人、跑批量期间不能端掉别人、接管前得先对账。
  var gIds = await stuckJobs(3, 'eee');          // 这一页自己抓的、勾上的三条（Part 2 的批量就跑这三条）
  var foreignId = 'eee-foreign';
  var jobsSeen = (window.__store.jobs || []).length;
  window.__store.jobs = (window.__store.jobs || []).concat([{ id: foreignId, title: '别的标签页刚抓到的岗位', company: '某外公司', sel: false, url: 'https://www.zhipin.com/job_detail/eee9.html' }]);
  var fd = {}; fd[foreignId] = { text: '别的标签页写好的草稿', ts: Date.now(), sent: false, fp: 'keepme' };
  window.__store.drafts = Object.assign({}, window.__store.drafts || {}, fd);
  clickTab('jobs');
  q('#j_here').click();        // 同一拍里点下去，不给「每 3 秒对一次账」补救的机会：验的就是回写本身
  var foreignKept = ((window.__store.drafts || {})[foreignId] || {}).text === '别的标签页写好的草稿';
  var foreignJobKept = (window.__store.jobs || []).some(function (j) { return j && j.id === foreignId; });
  add('这一页没见过的岗位和它的草稿，不能因为它自己抓一次列表就整块消失（旧写法连锅端）',
    foreignKept && foreignJobKept && (window.__store.jobs || []).length >= jobsSeen + 1,
    JSON.stringify({ 外来草稿: foreignKept, 外来岗位: foreignJobKept, 岗位数: jobsSeen + '→' + (window.__store.jobs || []).length }));

  // 跑批量期间这一页根本不会去对账（watchResume 一进门就 return），所以那几秒里别人写进来的草稿
  // 只能靠「每次只盖自己动过的那一条」保命。今日计数同理 —— 那是发送上限的账，被旧快照抹回去等于上限失效。
  window.__genDelay = 4000;
  clickTab('queue');
  q('#q_run').click();
  await waitFor(function () { return /批量进行中/.test(q('#bgStat').textContent); }, 8000);
  var mid = {}; mid[foreignId] = { text: '批量在跑的时候别的标签页又写了一条', ts: Date.now(), sent: false, fp: 'midme' };
  window.__store.drafts = Object.assign({}, window.__store.drafts || {}, mid);
  // 桩按引用存，所以必须整块换一个**新对象**：这一页内存里的 stats 还指着老那份（sent 停在它自己的数）
  var sentBeforeE = Number((window.__store.stats || {}).sent) || 0;
  window.__store.stats = { day: day0, sent: sentBeforeE + 9, generated: 30 };
  var doneE = await waitFor(function () { return /批量任务结束/.test(q('#bgFoot').textContent); }, 120000);
  window.__genDelay = 0;
  var keptMid = ((window.__store.drafts || {})[foreignId] || {}).text === '批量在跑的时候别的标签页又写了一条';
  add('批量正在跑的这几秒里，别的标签页写进来的草稿照样活着（三条并发生成，每条回写都不许带走别人的）',
    !!doneE && keptMid && gIds.every(function (i) { return !!(window.__store.drafts || {})[i]; }),
    JSON.stringify({ 跑完: !!doneE, 外来草稿: keptMid, 本轮三条都有: gIds.map(function (i) { return !!(window.__store.drafts || {})[i]; }) }));
  add('今日计数取两边的大值：别的页面已经多发出 9 条，不能被这一页的旧快照抹回去（那是发送上限的账）',
    Number((window.__store.stats || {}).sent) === sentBeforeE + 9,
    JSON.stringify({ 起点: sentBeforeE, 现在: window.__store.stats || {} }));

  // 接管的那一页得先跟存储对一次账，再决定「还剩几条」：它 boot 时看不见后来别处做完的那两条，
  // 不对账就会把已经做完的再烧一遍 token（用户截图里那个「剩 10/11 条」）。
  await reboot();              // F 页：boot 时 autoResume 仍是关的，只有我点它才动
  var fIds = await stuckJobs(3, 'fff');
  var seedF = {};
  seedF[fIds[0]] = { text: '上一页已经发出去了甲', ts: Date.now(), sent: true, fp: 'x' };
  seedF[fIds[1]] = { text: '上一页已经发出去了乙', ts: Date.now(), sent: true, fp: 'x' };
  window.__store.drafts = Object.assign({}, window.__store.drafts || {}, seedF);
  window.__store.bgBatch = { ids: fIds, autoSend: false, day: day0, tick: Date.now() - 90000, by: 'f-owner' };
  clickTab('queue');
  var sawOne = await waitFor(function () {
    return /可续跑 1 条/.test(q('#bgStat').textContent) && !!q('#q_resume');
  }, 10000);
  var reqF = genReqs().length;
  var fResume = q('#q_resume');
  if (fResume) fResume.click();
  var doneF = await waitFor(function () { return /批量任务结束/.test(q('#bgFoot').textContent); }, 120000);
  add('接管前先对账：已经做完的两条不再烧一遍 token，只补做剩下那条（旧版会把三条全重做）',
    !!sawOne && !!doneF && genReqs().length === reqF + 1,
    JSON.stringify({ 顶部: q('#bgStat').textContent, 新增请求: genReqs().length - reqF, 跑完: !!doneF }));

  // 「开始批量」这条入口也得先对账（它不经过 watchResume，靠的是 runBatch 进门那一次）。
  // 造法：G 页 boot 时这两条都还没草稿，草稿在 boot 之后由"别的标签页"写进存储 ——
  // 种子和点击放在同一拍里，抢在 3 秒一次的定时对账之前，验的就是 runBatch 自己那一次同步。
  var hIds = await stuckJobs(2, 'hhh');
  await reboot();              // G 页：内存里这两条都没有草稿
  var seedH = {}; seedH[hIds[0]] = { text: '别的标签页已经发出去的丙', ts: Date.now(), sent: true, fp: 'hh0' };
  window.__store.drafts = Object.assign({}, window.__store.drafts || {}, seedH);
  var reqH = genReqs().length;
  clickTab('queue');
  q('#q_run').click();
  var doneG = await waitFor(function () { return /批量任务结束/.test(q('#bgFoot').textContent); }, 120000);
  add('点「开始批量」的那一页也是先对账再开跑：别处已经做完的那条不再重做（同一拍里的种子，没靠定时轮询救）',
    !!doneG && genReqs().length === reqH + 1 &&
      ((window.__store.drafts || {})[hIds[0]] || {}).text === '别的标签页已经发出去的丙' &&
      !!((window.__store.drafts || {})[hIds[1]] || {}).text,
    JSON.stringify({ 新增请求: genReqs().length - reqH, 跑完: !!doneG, 那条草稿还在: ((window.__store.drafts || {})[hIds[0]] || {}).text }));

  // —— ⑨ 待抓详情清单也是整块：面板一条条排、详情页一进去就销自己那条，谁整块盖回去都会踩掉别人
  clickTab('jobs');
  window.__store.cfg = Object.assign({}, window.__store.cfg || {}, { autoResume: false });
  window.__store.jobs = [{ id: 'iii0', title: '岗位iii0号', url: 'https://www.zhipin.com/job_detail/iii0.html', sel: true }];
  window.__store.details = {};          // 这条岗位没 JD，所以点「抓选中岗位详情」真的会去排账
  await reboot();
  clickTab('jobs');
  window.__store.pendingDetails = [{ id: 'other998', url: 'https://www.zhipin.com/job_detail/other998.html', ts: Date.now() }];
  q('#j_detail').click();               // fetchDetails 里第一笔排账是同步发生的（await 在它后面）
  var pendNow = (window.__store.pendingDetails || []).map(function (p) { return p.id; });
  add('排「待抓详情」时只往里加：本页刚排的这条进账，别处刚排的那条不会被整块盖掉',
    pendNow.indexOf('other998') >= 0 && pendNow.indexOf('iii0') >= 0, JSON.stringify(pendNow));

  // —— ⑩ 「重置今日计数」不能被另一个还开着的旧标签页抬回原来的数字。
  //   到上限时日志让用户去「日志」页按重置，那是唯一的解限出口；而 v0.5.4 新加的「今日计数取两边的
  //   大值」正好把它克掉：旧标签页内存里还留着 3，它下一次回写就把刚清掉的 0 抬回 3，重置白按。
  //   所以按重置除了清数字还要盖一个时间戳，比这次重置旧的快照一律不作数。
  window.__store.stats = { day: day0, sent: 3, generated: 2 };   // 没有 resetAt = 这一页 boot 时从没听说过有人按过重置
  await reboot();                              // I 页：内存里 sent=3、generated=2
  var head10 = q('#bgStat').textContent;
  clickTab('jobs');
  var lIds = await stuckJobs(1, 'lll');
  window.__genDelay = 4000;                    // 让「另一页按重置」这一笔落在生成还没返回的那几秒里
  clickTab('queue');
  q('#q_run').click();
  var sawRun10 = await waitFor(function () { return /批量进行中/.test(q('#bgStat').textContent); }, 8000);
  // 桩按引用存，必须整块换一个**新对象**：只改嵌套键会连这一页内存里那份一起改掉，测不出覆盖
  window.__store.stats = { day: day0, sent: 0, generated: 0, resetAt: Date.now() };
  var done10 = await waitFor(function () { return /批量任务结束/.test(q('#bgFoot').textContent); }, 120000);
  window.__genDelay = 0;
  add('批量在跑的那几秒里别的页面按了「重置今日计数」，这一页回写时不许把旧的 3 抬回去（那是发送上限的账）',
    /今日 3\/60/.test(head10) && !!sawRun10 && !!done10 && Number((window.__store.stats || {}).sent) === 0,
    JSON.stringify({ 顶部: head10, 跑完: !!done10, 计数: window.__store.stats || {} }));
  add('可这一页刚生成的那条「今日已生成」不能被这次重置抹掉：上限跟着重置走、显示数只往上走',
    !!done10 && Number((window.__store.stats || {}).generated) >= 3,
    JSON.stringify(window.__store.stats || {}));

  // 另一半是用户真正会骂的地方：按完重置，旧标签页得真的能把额度重新用出去。它内存里还写着 3/3，
  // 开跑前不跟存储对账，就会自己对自己喊「触达今日发送上限，停止」—— 重置还是白按。
  clickTab('jobs');
  window.confirm = function () { return true; };
  q('#j_clear').click();                       // 清干净，K 页那一轮就只有一条岗位：计数能对上确切数字
  await waitFor(function () { return (window.__store.jobs || []).length === 0; }, 8000);
  clickTab('cfg');
  q('#m_auto').checked = true;
  q('#c_conc').value = '1';
  q('#c_max').value = '3';                     // 上限 3、旧快照也记着 3：不对账就正好卡死
  q('#c_save2').click();
  await waitFor(function () {
    var c = window.__store.cfg || {};
    return c.autoSend === true && Number(c.maxPerDay) === 3;
  }, 4000);
  var nIds = await stuckJobs(1, 'nnn');
  window.__store.stats = { day: day0, sent: 3, generated: 3 };
  await reboot();                              // K 页：boot 时「今天已经发满 3 条」，且不知道刚有人重置过
  window.__store.stats = { day: day0, sent: 0, generated: 0, resetAt: Date.now() };
  var reqK = genReqs().length, openK = (window.__opened || []).length;
  clickTab('queue');
  q('#q_run').click();
  var doneK = await waitFor(function () { return /批量任务结束/.test(q('#bgFoot').textContent); }, 120000);
  add('别的页面按过重置后，这一页内存里那条旧的 3/3 不能把自己拦在上限里：开跑前对账，然后真的发出去、从 0 重新计起',
    !!doneK && genReqs().length === reqK + 1 && (window.__opened || []).length === openK + 1 &&
      Number((window.__store.stats || {}).sent) === 1,
    JSON.stringify({ 跑完: !!doneK, 新增请求: genReqs().length - reqK, 新开标签: (window.__opened || []).length - openK, 计数: window.__store.stats || {} }));

  // —— ⑪ 换日：昨天那张账不许占今天的额度（today() 用 UTC，所以北京时间 08:00 翻）
  var yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  window.__store.stats = { day: yday, sent: 4, generated: 9 };
  await reboot();                              // L 页：今早第一次起来的这一页，存储里那本账还停在昨天
  var head11 = q('#bgStat').textContent;
  add('今天第一次起来的页面把昨天那 4 条归零：那是「今日」上限的账，旧写法原样搬进今天，害你每天早上都得自己按一次重置才还得回来',
    /今日 0\//.test(head11), head11);

  // 同一页一直开着、时钟正好跨过换日那一刻 —— 归零不能只发生在 boot，3 秒一次的同步里也得滚。
  // 造法：把 toISOString 往后挪一天（代码里的 today() 就是它切前 10 位），等一次定时对账，再挪回来。
  var realISO = Date.prototype.toISOString;
  window.__store.stats = { day: day0, sent: 2, generated: 2 };   // 先让这一页认到今天已经发了 2 条
  await waitFor(function () { return /今日 2\//.test(q('#bgStat').textContent); }, 10000);
  Date.prototype.toISOString = function () { return realISO.call(new Date(this.getTime() + 86400000)); };
  await sleepMs(4200);                                            // 等下一次 syncFromStorage
  var head11b = q('#bgStat').textContent;
  Date.prototype.toISOString = realISO;
  add('页面从昨晚一直开到今天下午，也在下一次对账时自己归零（不用重开页面、不用手按重置）',
    /今日 0\//.test(head11b), head11b);

  /* ================== ⓬⓭⓮ v0.5.5：把这一轮交给后台的「生成器」标签页 ==================
   * 用户要的是「即使我离开了，语句生成也不能被打断」。v0.5.3 的落盘续跑只能「事后接上」，
   * 接上那几秒生成确实是停的，而且还得吃一道「是否离开网站？」。所以循环搬到他不会跳走的那一页：
   * 脚本自己 GM_openInTab 开出来、自己认、用完自己关的那个后台标签页。
   * 这一组验面板这一半（写交接单、只看不干、进度可见、暂停/停止是指令、失败退回、死了重派）；
   * 那一半（认领/心跳/真暂停/真停止/护栏只武装在执行者身上/自己收工）由 test/ui-exec.html 验。
   */
  function execLogTxt() { return String((window.__store.bgLogExec || []).join('\n')); }
  function planP() { return window.__store.bgBatch || {}; }
  function stOf(id) { var r = rowOf(id); return r ? (((r.querySelector('.st') || {}).textContent) || '') : '行没了'; }
  // 每一组都先把列表清空：不清的话「开始批量」会把前面几段留下的岗位一起拖进来，
  // 耗时和请求数都对不上（清空列表同时作废计划和没人认领的交接单，见 #j_clear）。
  async function execSetup(semi) {
    clickTab('jobs');
    window.confirm = function () { return true; };
    q('#j_clear').click();
    await waitFor(function () { return (window.__store.jobs || []).length === 0; }, 8000);
    clickTab('cfg');
    q('#c_exec').checked = true;
    q(semi ? '#m_semi' : '#m_auto').checked = true;
    q('#c_conc').value = '1';
    q('#c_save2').click();
    await waitFor(function () { var c = window.__store.cfg || {}; return c.bgExecutor === true && c.autoSend === !semi; }, 4000);
  }

  // —— ⓬ 交接真的发生，而且面板从头到尾只是个观众
  clickTab('cfg');
  var execSw = q('#c_exec');
  add('v0.5.5 设置页有「批量交给后台生成器」开关，勾选状态跟着存储走（这一页为了钉住前面那批老断言起手把它关着）',
    !!execSw && execSw.checked === false, 'checked=' + (execSw ? execSw.checked : 'missing'));
  add('开关的说明把代价讲实话（隐藏标签页定时器会被压、多一个标签页、交接要等），不是只写「更快更稳」', (function () {
    var h = execSw ? execSw.closest('label').nextElementSibling : null;
    return !!h && /代价/.test(h.textContent) && /隐藏/.test(h.textContent);
  })(), (function () { var h = execSw ? execSw.closest('label').nextElementSibling : null; return h ? h.textContent.slice(0, 46) : 'missing'; })());
  await execSetup(true);
  add('勾上「交给生成器」真的落库（下次进页面还是这个选择）',
    (window.__store.cfg || {}).bgExecutor === true, JSON.stringify((window.__store.cfg || {}).bgExecutor));

  window.__genDelay = 4000;                 // 每条 4 秒：够把「正在被生成器写的那条」看个清楚
  q('#chatBox').style.display = 'block';    // 故意把这一页演成沟通页：生成器绝不能开在这种页上
  var eIds = await stuckJobs(2, 'eee');
  clickTab('queue');
  var reqE = genReqs().length, openE = (window.__opened || []).length, tabE = window.__execTabs;
  q('#q_run').click();
  var snapExec = JSON.parse(JSON.stringify(window.__store.bgExec || {}));
  var snapOpen = String((window.__opened || [])[openE] || '');
  q('#chatBox').style.display = 'none';
  var sawHand = /正在交接给生成器标签页/.test(q('#bgStat').textContent);
  add('点「开始批量」先递一张交接单（这一轮跑哪几条 + 一次性凭证 + 还没人认领），顶部立刻切成「正在交接给生成器标签页…」',
    !!sawHand && !!snapExec.token && snapExec.ids.length === 2 && !snapExec.claimed,
    JSON.stringify({ 条数: snapExec.ids.length, 认领: snapExec.claimed, 顶部: q('#bgStat').textContent }));
  add('生成器绝不开在你正看着的这一页（尤其不开在有真输入框的沟通页：别让执行者有机会把自己当发送现场）',
    /^https:\/\/www\.zhipin\.com\//.test(snapOpen) &&
      snapOpen.slice(-('#bgExec=' + snapExec.token).length) === '#bgExec=' + snapExec.token,
    snapOpen.slice(0, 90));
  var tookE = await waitFor(function () { return planP().role === 'exec' && planP().by && (window.__store.bgExec || {}).claimed; }, 15000);
  add('那一页真的接手了：凭证认领写回存储，计划归到它自己名下且 role=exec',
    !!tookE, JSON.stringify({ 认领: (window.__store.bgExec || {}).claimed, role: planP().role }));
  add('只开一个标签页（交接期间每 3 秒一次的自动接管被 execPending 挡住，不会凭空多开）',
    window.__execTabs - tabE === 1 && (window.__opened || []).length - openE === 1,
    JSON.stringify({ 生成器: window.__execTabs - tabE, 新开标签: (window.__opened || []).length - openE }));
  var liveE = await waitFor(function () { return /生成器正在跑（剩/.test(q('#bgStat').textContent); }, 15000);
  add('顶部进度读的是生成器公布出来的那份，不是本页内存 —— 这一页没跑，所以也不叫「批量进行中」',
    !!liveE && !/批量进行中/.test(q('#bgStat').textContent), q('#bgStat').textContent);
  // 用户这句话才是这一版的验收标准：「即使我离开了，语句生成也不能被打断」。
  // 断言必须问在「生成器正跑着、这一页只是观众」的那个时刻 —— 前面 1288 那条问的是「什么都没跑」，
  // 它挡不住「护栏无条件武装」这种破坏：那种写法在闲置页也不拦，只在观众页拦，而观众页以前没人问。
  var evE = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(evE);
  add('生成器在跑的时候，你正看着的这一页不拦你离开（「是否离开网站？」不再打扰正常翻页 —— 这一页跳走什么都不打断）',
    !evE.defaultPrevented, 'defaultPrevented=' + evE.defaultPrevented + '，bgStat=' + q('#bgStat').textContent);
  // 上一条只证明「本页不拦」，它挡不住「干脆把护栏删了」这种写法 —— 那条得由这一条补：
  // 桩里把生成器那份闭包的 beforeunload 注册收在 __execGuards 里（真机上它挂在另一张标签页的
  // window 上，本来就不该作用到本文档），这里直接调它，问「执行者那一页到底还拦不拦」。
  var evG = new Event('beforeunload', { cancelable: true });
  (window.__execGuards || []).forEach(function (f) { try { f(evG); } catch (e) {} });
  add('护栏没被删掉、只是挪到了执行者那一页：生成器自己那份闭包注册了 beforeunload，跑着的时候确实会拦',
    (window.__execGuards || []).length > 0 && evG.defaultPrevented,
    JSON.stringify({ 注册了几条: (window.__execGuards || []).length, 会拦: evG.defaultPrevented }));
  add('队列页那段说明跟着设置走：开着交接就写明「由脚本自己开的后台生成器标签页来跑」',
    /后台「生成器」标签页来跑/.test(q('#bgBody').textContent),
    (q('#bgBody').textContent.match(/这一轮由[^：]{0,30}生成器[^。]{0,20}/) || ['无'])[0]);
  var genRowE = await waitFor(function () {
    var g = (planP().gen || [])[0];
    return g && /生成中/.test(stOf(g)) ? g : null;
  }, 15000);
  add('计划里正被生成器写的那条，行内徽章是「生成中」不是「待处理」（用户报的现场就是跳一次页面全退回待处理）',
    !!genRowE, JSON.stringify({ 在写: genRowE || '没抓到在飞的那条', 徽章: eIds.map(stOf) }));
  var doneE = await waitFor(function () { return eIds.every(function (id) { return !!(draftOf(id) || {}).text; }); }, 40000);
  add('两条草稿由生成器写进存储（这一轮大模型请求正好两条，一条不多一条不少）',
    !!doneE && genReqs().length - reqE === 2, JSON.stringify({ 新增请求: genReqs().length - reqE, 草稿: eIds.map(function (id) { return !!draftOf(id); }) }));
  clickTab('log'); await sleepMs(400);
  var pLogE = q('#bgLog').value;
  // 只看「这次交接之后」的那几行：这一页是 ⑦ 之后 reboot 出来的第 N 个上下文，
  // restoreLog 会把上一页的整份日志接回来，前面几段跑内联批量时写的「本轮 N 个岗位」还留在里头。
  var pLogTail = pLogE.slice(Math.max(0, pLogE.lastIndexOf('正在把这一轮交给后台')));
  add('循环真的活在生成器那一页：面板日志只有交接、一句「本轮 N 个岗位」都没有，那几行在生成器的日志副本里',
    /正在把这一轮交给后台的「生成器」标签页/.test(pLogE) && /生成器已接手/.test(pLogE) &&
      !/本轮 \d+ 个岗位/.test(pLogTail) && /生成器标签页起来了/.test(execLogTxt()) && /本轮 2 个岗位/.test(execLogTxt()),
    JSON.stringify({ 面板交接后: pLogTail.split(String.fromCharCode(10)).slice(0, 4).join(' | '),
      生成器: (execLogTxt().match(/[^\n]*本轮[^\n]*/g) || ['无'])[0] }));
  add('日志页另开一块只读生成器那份，还带「复制生成器日志」（出问题时用户自己就能把两份日志都给我）',
    !!q('#bgExecLog') && !!q('#l_copyex') && /生成器标签页的日志/.test(q('#bgBody').textContent),
    q('#bgExecLog') ? q('#bgExecLog').value.split('\n').length + ' 行' : 'missing');
  add('生成器把自己那一页的标题改成「招呼语生成器 · 请别关这个标签页」，用户一眼认得出该留哪一页',
    /招呼语生成器/.test(document.title), document.title);
  clickTab('queue');
  var stE = await waitFor(function () { return eIds.every(function (id) { return /已生成|待确认/.test(stOf(id)); }); }, 12000);
  add('生成器写的草稿带着它自己算的指纹回来，面板重画后是「已生成」：既不退回「待处理」，也不报「草稿已过期」',
    !!stE, eIds.map(stOf).join(' / '));
  var finE = await waitFor(function () { return !planP().ids && /全部跑完，这个标签页马上自己关掉/.test(execLogTxt()); }, 12000);
  add('跑完这一轮计划清空、生成器自己收工（不会留一个空转的标签页占着浏览器）',
    !!finE, JSON.stringify({ 计划: Object.keys(planP()).length, 日志: (execLogTxt().match(/[^\n]*全部跑完[^\n]*/) || ['无'])[0] }));

  // —— ⓬b 观众页的「暂停 / 停止」只是留指令，真的压在生成器的节奏上
  await execSetup(true);
  window.__genDelay = 6000;                 // 每条 6 秒：够我先按暂停、看它真的停下，再按停止
  var gIds = await stuckJobs(3, 'ggg');
  clickTab('queue');
  var tabG = window.__execTabs, reqG = genReqs().length;
  q('#q_run').click();
  var liveG = await waitFor(function () { return planP().role === 'exec' && planP().by; }, 15000);
  var stopBtnG = await waitFor(function () { return q('#q_run') && q('#q_run').textContent === '停止批量'; }, 12000);
  add('交接成功后按钮自己变成「停止批量」（观众页知道自己拦不住执行者，点它只是发指令）',
    !!liveG && !!stopBtnG, '按钮=' + (q('#q_run') ? q('#q_run').textContent : 'missing'));
  q('#q_pause').click();
  var pauseG = await waitFor(function () { return planP().pause === true; }, 6000);
  var statPauseG = await waitFor(function () { return /，已暂停）/.test(q('#bgStat').textContent); }, 12000);
  clickTab('log'); await sleepMs(300);
  add('观众页按「暂停」写的是给生成器的指令：计划上落下 pause=true、顶部显示已暂停，日志说的是「已通知」而不是「已暂停」',
    !!pauseG && !!statPauseG && /已通知生成器标签页暂停/.test(q('#bgLog').value),
    JSON.stringify({ pause: planP().pause, 顶部: q('#bgStat').textContent, 日志: (q('#bgLog').value.match(/[^\n]*已通知[^\n]*/g) || ['无']).pop() }));
  var oneG = await waitFor(function () { return !!(draftOf(gIds[0]) || {}).text; }, 30000);
  await sleepMs(3000);
  add('暂停真的压在生成器那一页的生成节奏上：飞完手上这条就不往下走了（不是只改了改按钮）',
    !!oneG && !draftOf(gIds[1]) && !draftOf(gIds[2]),
    JSON.stringify(gIds.map(function (id) { return !!draftOf(id); })));
  clickTab('queue');
  q('#q_pause').click();
  var resumeG = await waitFor(function () { return planP().pause === false; }, 6000);
  clickTab('queue');
  var startedG2 = planP().started || 0;
  q('#q_run').click();                       // 这时它是「停止批量」
  // 当场读、别 waitFor：执行者一收到停止就把这份计划重写成「没人认领」（stop 归零），
  // 中间那不到 2 秒不是这条断言要验的东西 —— 要验的是「观众页只留了指令，自己没动手」。
  var stopG = Number(planP().stop) > 0 && Number(planP().stop) >= startedG2;
  var stopEndG = await waitFor(function () { return /可续跑 \d+ 条/.test(q('#bgStat').textContent); }, 30000);
  clickTab('log'); await sleepMs(300);
  add('「停止批量」也只是留指令：执行者自己收手，剩下的退回「可续跑 N 条」，两边日志各写各的',
    !!resumeG && !!stopG && !!stopEndG && /已通知生成器标签页停止/.test(q('#bgLog').value) && /收到停止/.test(execLogTxt()),
    JSON.stringify({ 顶部: q('#bgStat').textContent, 面板尾: q('#bgLog').value.split(String.fromCharCode(10)).slice(-10).join(' | '),
      生成器: (execLogTxt().match(/[^\n]*收到停止[^\n]*/g) || ['无']).pop() }));
  var leftG = String((q('#bgStat').textContent.match(/可续跑 (\d+) 条/) || [])[1] || '');
  var tabG2 = window.__execTabs;
  clickTab('queue');
  if (q('#q_resume')) q('#q_resume').click();
  var tookG2 = await waitFor(function () { return window.__execTabs > tabG2 && planP().role === 'exec'; }, 20000);
  add('「继续上次批量」也走交接，不在这一页自己跑，而且只补派一个生成器',
    !!tookG2 && window.__execTabs - tabG2 === 1, JSON.stringify({ 剩: leftG, 补派: window.__execTabs - tabG2 }));
  var doneG = await waitFor(function () { return gIds.every(function (id) { return !!(draftOf(id) || {}).text; }); }, 60000);
  add('续跑把剩下那几条补齐（三条草稿全在；已经有草稿的那条不再重烧 token）',
    !!doneG && genReqs().length - reqG <= 3, JSON.stringify({ 请求: genReqs().length - reqG, 草稿: gIds.map(function (id) { return !!draftOf(id); }) }));

  // —— ⓭ 那一页压根没起来（没被油猴注入 / 被站点弹的登录框挡住）：不能硬等，得退回本页
  await execSetup(true);
  window.__execSpawn = 'none';
  window.__genDelay = 2000;
  var pIds = await stuckJobs(2, 'ppp');
  clickTab('queue');
  var tabP = window.__execTabs;
  q('#q_run').click();
  var sawHandP = /正在交接给生成器标签页/.test(q('#bgStat').textContent);
  var fellP = await waitFor(function () { return /批量进行中/.test(q('#bgStat').textContent); }, 40000);
  clickTab('log'); await sleepMs(300);
  add('生成器 25 秒没认领就不干等：日志说清为什么，退回你正看着的这一页把这一轮跑完（这一条真的会占 25 秒虚拟时间）',
    !!sawHandP && !!fellP && /25 秒内没人认领/.test(q('#bgLog').value),
    JSON.stringify({ 交接: sawHandP, 退回: !!fellP, 日志: (q('#bgLog').value.match(/[^\n]*没人认领[^\n]*/) || ['无'])[0] }));
  add('等交接那 25 秒里只派过一次：每 3 秒一次的自动接管不会凭空多开第二个生成器',
    window.__execTabs - tabP === 1, '新增标签页 ' + (window.__execTabs - tabP));
  var evP = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(evP);
  add('退回本页、这一页就是执行者时，「是否离开网站？」护栏重新武装 —— 它只在真的没人替我跑的时候才拦',
    evP.defaultPrevented, 'defaultPrevented=' + evP.defaultPrevented);
  var doneP = await waitFor(function () { return /批量任务结束/.test(q('#bgFoot').textContent); }, 40000);
  add('退回本页也把这一轮跑完（两条草稿都在，交接失败不等于任务失败）',
    !!doneP && pIds.every(function (id) { return !!(draftOf(id) || {}).text; }),
    JSON.stringify({ 结束: !!doneP, 草稿: pIds.map(function (id) { return !!draftOf(id); }) }));
  window.__execSpawn = 'real';

  // —— ⓮ 生成器中途死了（被用户关掉 / 被 Edge 的睡眠标签页回收）：别的页面再开一个接着跑
  clickTab('cfg');
  q('#c_resume').checked = true;
  q('#c_save2').click();
  await waitFor(function () { return (window.__store.cfg || {}).autoResume === true; }, 4000);
  window.__genDelay = 9000;                 // 每条 9 秒：留够「它还没跑完就断了」的观察窗口
  var qIds = await stuckJobs(2, 'qqq');
  clickTab('queue');
  var tabQ = window.__execTabs;
  q('#q_run').click();
  var tookQ = await waitFor(function () {
    return planP().role === 'exec' && planP().by && (window.__store.bgExec || {}).claimed;
  }, 15000);
  // 得等它把交接单认领掉再动手：认领之前执行者正卡在「写下计划 → 读回来确认还是我的」那一步，
  // 这时候把 by 改成别的 token 会被它当成「另一页同时认领了这一轮」当场收工 ——
  // 那演的是「两个生成器抢一轮」，不是本段要演的「跑了一半死掉」。
  // 演「那一页没了」：把心跳写成 40 秒前、归属改成一个已经不存在的 token。
  // 真脚本里执行者每次心跳发现 p.by 不是自己就立刻停表 —— 和那一页被关掉留下的心跳一模一样。
  // 注意得赶在它把两条都写完之前动手：都写完了「剩 0 条」，本来就轮不到重派（那是另一条断言的事）。
  window.__store.bgBatch = Object.assign({}, planP(), { by: 'ghost-page', tick: Date.now() - 40000 });
  var respawnQ = await waitFor(function () { return planP().role === 'exec' && planP().by && planP().by !== 'ghost-page'; }, 40000);
  clickTab('log'); await sleepMs(300);
  add('生成器死了不丢已经生成的草稿，十几秒内自动再开一个接着跑剩下的（日志说是谁的账断了）',
    !!tookQ && !!respawnQ && /自动重新开一个接着跑/.test(q('#bgLog').value),
    JSON.stringify({ 重派: !!respawnQ, 日志: (q('#bgLog').value.match(/[^\n]*自动重新开一个[^\n]*/g) || ['无']).pop() }));
  add('重派也去重：同一份计划 30 秒内只派一次（respawn 先落盘，3 秒一次的检查不会连着开出好几个生成器）',
    window.__execTabs - tabQ === 2, '从第一次交接到现在共开出 ' + (window.__execTabs - tabQ) + ' 个生成器标签页');
  var doneQ = await waitFor(function () { return qIds.every(function (id) { return !!(draftOf(id) || {}).text; }); }, 60000);
  add('重派出来的那一个把剩下那几条跑完（这一轮不该因为死过一次就半途而废）',
    !!doneQ, JSON.stringify(qIds.map(function (id) { return !!draftOf(id); })));
  window.__genDelay = 0;
  // 收尾停在日志页：headless 的 --dump-dom 只留最后一帧 DOM，停在这儿方便事后 grep 两份日志
  clickTab('log'); await sleepMs(400);

  add('页面上任何可见文本都不含 API Key', document.body.innerText.indexOf('sk-test-1234567890') < 0, '');
  add('运行期无未捕获错误', window.__errors.length === 0, window.__errors.join(' ;; '));

}
function render() {
  var bad = R.filter(function (r) { return !r.pass; }).length;
  document.getElementById('rows').innerHTML = R.map(function (r) {
    return '<tr><td>' + r.name + '</td><td class="' + (r.pass ? 'pass">PASS' : 'fail">FAIL') + '</td><td class="extra">' +
      String(r.extra).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</td></tr>';
  }).join('');
  document.getElementById('sum').innerHTML = bad ? '<span class="fail">' + bad + ' 项失败</span> / 共 ' + R.length + ' 项' : '<span class="pass">全部 ' + R.length + ' 项通过</span>';
  window.__RESULT = R;
}
(async function () {
  try { await run(); }
  catch (e) { add('测试脚本自身异常', false, e.message + ' @ ' + String(e.stack || '').split('\n')[1]); }
  render();
})();`;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>UI 冒烟测试</title>
<style>
body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:20px 20px 140px}
#chatBox{position:fixed;left:20px;bottom:20px;width:360px;background:#f2f6ff;border:1px solid #cfe0ff;padding:8px}
#chatBox textarea{width:300px;height:52px}
.vip-box{margin:18px 0;width:300px}
.vip-box input{width:250px;height:28px}
.pass{color:#1c8a45;font-weight:600}.fail{color:#c8402f;font-weight:600}
.extra{color:#7a8698;font-size:12px;word-break:break-all}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #eee;padding:5px 8px;text-align:left;vertical-align:top}
#sum{font-size:16px;margin:8px 0}
</style></head><body>
<h3>BOSS 打招呼助手 · 端到端冒烟测试（GM API 全部打桩）</h3>
<div id="sum">运行中…</div>
<table><thead><tr><th style="width:38%">断言</th><th style="width:8%">结果</th><th>实际值</th></tr></thead><tbody id="rows"></tbody></table>
${siteFixture}
<script>${stubs}<\/script>
<script>/* ==== .user.js 原文 ==== */
${src}
<\/script>
<script id="bgSrc" type="text/plain">/* .user.js 原文的第二份（不执行）：续跑用例要「重新加载这一页」，
   单文件测试里真的 reload 会把断言一起冲掉，所以把原文再执行一遍当成新页面 ——
   新执行 = 新闭包（states / logBuf / runner / 批量循环全是新的），只有油猴存储那份还在。 */
${src}
<\/script>
<script>${asserts}<\/script>
</body></html>
`;

fs.writeFileSync(path.join(root, 'test', 'ui-smoke.html'), html);

/* ==========================================================================
 * 第二个页面：模拟「被脚本开出来的岗位标签页」，专门验接收端
 *   sendReq.url === location.href 时，boot 必须优先走发送分支（不是详情抓取分支），
 *   然后自动点「立即沟通」-> 填草稿 -> 点文字为「发送」的真按钮 -> 回执写回油猴存储。
 * ========================================================================== */
const sendTabFixture = String.raw`
<div id="site">
  <div class="job-detail"><h1>Java 后端工程师</h1><p>负责订单中台与稳定性治理，要求 Spring Boot、MySQL、Redis。</p></div>
  <div class="btn btn-startchat-wrap" id="greetWrap"><a class="btn btn-startchat" id="greetBtn" href="javascript:;" redirect-url="/web/geek/chat?id=bb1&amp;jobId=seedjob&amp;securityId=s1" data-isfriend="false">立即沟通</a></div>
</div>
<div id="chatBox" style="display:none">
  <div class="chat-tool">
    <div class="chat-send-img" role="button" title="发送图片" id="imgBtn"><input type="file" id="fileIn" accept="*.gif;*.jpg;*.png"><span>发送</span></div>
  </div>
  <div class="chat-input" contenteditable="true"></div>
  <button class="btn-v2 btn-sure-v2 btn-send disabled" id="sendBtn">发送</button>
</div>`;

// 预置油猴存储，等价于「发送方刚 GM_setValue('sendReq') + GM_openInTab 打开了这个页面」
const sendTabSeed = String.raw`
window.__store.cfg = { autoSend: true, autoOpenChat: true, autoCloseDetail: false,
  apiBase: 'https://api.test.local/v1', apiKey: 'sk-test-1234567890', model: 'test-model' };
window.__store.sendReq = { url: location.href, text: 'SEED-给HR的招呼语', id: 'seedjob', ts: Date.now() };
// 关键陷阱：这个 URL 同时也在详情待抓队列里。旧版 boot 先判详情，于是这个标签页去抓详情、
// 把自己关掉，发送从来没发生，发送方干等 45s 超时 —— 用户看到的就是「还得我自己进沟通页」。
window.__store.pendingDetails = [{ id: 'seedjob', url: location.href.split('?')[0].split('#')[0] }];
window.__store.drafts = {};
window.__store.stats = { sent: 0 };`;

const sendTabAsserts = String.raw`
var R = [];
function add(n, p, x) { R.push({ name: n, pass: !!p, extra: x == null ? '' : String(x) }); }
function q(s) { return document.querySelector(s); }
function waitFor(fn, ms) {
  return new Promise(function (res) {
    var t0 = Date.now();
    (function loop() { var v = fn(); if (v) return res(v);
      if (Date.now() - t0 > (ms || 4000)) return res(null); setTimeout(loop, 40); })();
  });
}
async function run() {
  await waitFor(function () { return window.__greetClicks > 0; }, 15000);
  add('发送标签页自动点了「立即沟通」', window.__greetClicks > 0, 'greetClicks=' + window.__greetClicks);
  add('发送标签页不建面板（用户不会误以为要在这儿手工操作）', !q('#bgPanel'), q('#bgPanel') ? '建了面板' : '没建');
  await waitFor(function () { return window.__sent.length > 0; }, 15000);
  add('沟通页打开后自动填入并发出招呼语', window.__sent[0] === 'SEED-给HR的招呼语', JSON.stringify(window.__sent).slice(0, 60));
  add('点的是文字为「发送」的真按钮，没误点「发送图片」上传控件', window.__fileClicks === 0, 'fileClicks=' + window.__fileClicks);
  var res = await waitFor(function () { return window.__store.sendRes && window.__store.sendRes.seedjob; }, 8000);
  add('回执写回油猴存储，发送方据此判定成败', !!res && res.ok === true && res.url === location.href, JSON.stringify(res).slice(0, 90));
  add('回执带上发送方式（按钮/回车）', !!res && /button|enter/.test(res.how || ''), res ? String(res.how) : '无回执');
  add('发成功后上闩，同一岗位不会在别的标签页再发一遍', window.__store['sendDone:seedjob' + location.href] === true,
    String(window.__store['sendDone:seedjob' + location.href]));
  add('详情抓取没有抢占发送（同一条 URL 在 pendingDetails 里也不走详情分支）',
    !(window.__store.details || {}).seedjob, JSON.stringify(window.__store.details || {}).slice(0, 60));
  add('页面上任何可见文本都不含 API Key', document.body.innerText.indexOf('sk-test-1234567890') < 0, '');
  add('运行期无未捕获错误', window.__errors.length === 0, window.__errors.join(' ;; '));
}
function render() {
  var bad = R.filter(function (r) { return !r.pass; }).length;
  document.getElementById('rows').innerHTML = R.map(function (r) {
    return '<tr><td>' + r.name + '</td><td class="' + (r.pass ? 'pass">PASS' : 'fail">FAIL') + '</td><td class="extra">' +
      String(r.extra).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</td></tr>';
  }).join('');
  document.getElementById('sum').innerHTML = bad ? '<span class="fail">' + bad + ' 项失败</span> / 共 ' + R.length + ' 项' : '<span class="pass">全部 ' + R.length + ' 项通过</span>';
  window.__RESULT = R;
}
(async function () {
  try { await run(); }
  catch (e) { add('测试脚本自身异常', false, e.message + ' @ ' + String(e.stack || '').split('\n')[1]); }
  render();
})();`;

const html2 = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>发送标签页测试</title>
<style>
body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:20px 20px 140px}
#chatBox{position:fixed;left:20px;bottom:20px;width:360px;background:#f2f6ff;border:1px solid #cfe0ff;padding:8px}
#chatBox textarea{width:300px;height:52px}
.pass{color:#1c8a45;font-weight:600}.fail{color:#c8402f;font-weight:600}
.extra{color:#7a8698;font-size:12px;word-break:break-all}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #eee;padding:5px 8px;text-align:left;vertical-align:top}
#sum{font-size:16px;margin:8px 0}
</style></head><body>
<h3>BOSS 打招呼助手 · 「被开出来的岗位标签页」接收端测试</h3>
<div id="sum">运行中…</div>
<table><thead><tr><th style="width:38%">断言</th><th style="width:8%">结果</th><th>实际值</th></tr></thead><tbody id="rows"></tbody></table>
${sendTabFixture}
<script>${stubs}<\/script>
<script>${sendTabSeed}<\/script>
<script>/* ==== .user.js 原文 ==== */
${src}
<\/script>
<script>${sendTabAsserts}<\/script>
</body></html>
`;

fs.writeFileSync(path.join(root, 'test', 'ui-sendtab.html'), html2);

/* ==========================================================================
 * 第三个页面：模拟「点了继续沟通之后整页跳转到沟通页」的接力后半程。
 *   真实站点上这一跳会把本上下文的 await 全部销毁，所以回执必须由跳过来的这一页写；
 *   而沟通页加载完会把 URL 上的 ?jobId= 洗掉，会话身份只能靠「导航计时里那条原始 URL」
 *   和右侧职位卡（span.position-name）反查。
 *   用 ?case= 分七种情形，run.js 把同一个文件渲染七遍。
 * ========================================================================== */
// 结构照 2026-10-16 实测的真实沟通页抄：
//   整页没有任何 a[href*="job_detail"]（「查看职位」是个不带 href 的 div），
//   职位名在 <span class="position-name">，输入框在 .chat-conversation>.message-controls>.chat-im>.editor-container>div.chat-input
const hopFixture = String.raw`
<div id="site">
  <div class="chat-list">
    <div class="conv conv-on">张三 示例网络科技 | 前端工程师 17:04</div>
    <div class="conv">Go 平台开发工程师 · 深圳某云厂商</div>
  </div>
  <div class="chat-conversation">
    <div class="chat-head"><span class="position-name">28届后端实习生-示例短视频</span><span class="salary">200-250元/天</span><span class="city">上海</span><span class="view-job">查看职位</span></div>
    <div class="message-controls">
      <div class="chat-im chat-editor">
        <div class="editor-container">
          <div class="chat-tool">
            <div class="chat-send-img" role="button" title="发送图片" id="imgBtn"><input type="file" id="fileIn" accept="*.gif;*.jpg;*.png"><span>发送</span></div>
          </div>
          <div class="chat-input" contenteditable="true"></div>
        </div>
        <button class="btn-v2 btn-sure-v2 btn-send disabled" id="sendBtn">发送</button>
      </div>
    </div>
  </div>
</div>`;

const hopSeed = String.raw`
// 沟通页这一半没有 jobId 可用（URL 被站点洗掉了），所以「我是谁派来的」只能靠 sessionStorage 里的接力牌。
// 它跟着标签页走、别的标签页看不见，正好把「用户自己随手开一个沟通页」和「脚本刚点进来的那一跳」区分开。
window.__case = (location.search.match(/case=(\w+)/) || [])[1] || 'ok';
// 真实沟通页：地址栏被 SPA 洗成 /web/geek/chat，但浏览器自己的导航计时里还留着那一跳的完整 query。
window.__nav = 'https://www.zhipin.com/web/geek/chat';
performance.getEntriesByType = function (t) { return t === 'navigation' ? [{ name: window.__nav }] : []; };
window.__hop = { jobId: 'aaa111', jobUrl: 'https://www.zhipin.com/job_detail/aaa111.html?lid=x',
  title: '28届后端实习生-示例短视频', company: '示例网络科技', text: 'HOP-接力招呼语', ts: Date.now(), from: 'entry',
  chat: { id: '1234567890abcdef', jobId: 'aaa111', securityId: 'sec-xyz' } };
var NAVQ = '?id=1234567890abcdef&jobId=aaa111&securityId=sec-xyz&lid=';
if (window.__case === 'wrong') {
  // 接力牌指向另一个岗位：导航 URL 说的是这一页真正打开的岗位（aaa111），两边对不上，必须停手
  window.__hop = { jobId: 'zzz999', jobUrl: 'https://www.zhipin.com/job_detail/zzz999.html',
    title: 'Go 平台开发工程师', company: '深圳某云厂商', text: 'HOP-不该发出去的话', ts: Date.now(), from: 'entry',
    chat: { id: 'other', jobId: 'zzz999', securityId: 'sec-other' } };
  window.__nav = 'https://www.zhipin.com/web/geek/chat?id=1234567890abcdef&jobId=aaa111&securityId=sec-xyz';
}
if (window.__case === 'dirty') {
  // 用户日志里的真实情形：收藏列表把地点混进了岗位名，而沟通页只有纯岗位名，
  // 且这一例故意不给导航 URL（站点哪天不洗地址栏、或 SPA 没重新加载，都得能确认）
  window.__hop.title = '28届后端实习生-示例短视频 [ 上海·浦东新区 ]';
  window.__nav = 'https://www.zhipin.com/web/geek/chat';
}
if (window.__case === 'notitle') {
  // 站点改版：职位卡没渲染出来，也没有导航 URL —— 不许瞎发，但要把话填好交给用户
  window.__nav = 'https://www.zhipin.com/web/geek/chat';
  var pn = document.querySelector('.position-name');
  if (pn) pn.parentNode.removeChild(pn);
}
if (window.__case === 'stale') {
  window.__hop.ts = Date.now() - 120000;   // 过期牌：直接作废，既不发也不写回执
}
if (window.__case === 'fill') {
  // 半自动：走到沟通页只填不发，最后那一下留给用户点
  window.__hop.fillOnly = true;
}
// 载体：ss / fill 演「sessionStorage 那张牌」（主路径），其余只留油猴存储那份（站点改开新标签时的兜底）
if (window.__case === 'ss' || window.__case === 'fill' || window.__case === 'ok') {
  window.__nav = 'https://www.zhipin.com/web/geek/chat' + NAVQ;
}
if (window.__case === 'ss' || window.__case === 'fill') {
  sessionStorage.setItem('bgGreetHop', JSON.stringify(window.__hop));
} else {
  window.__store.sendHop = window.__hop;
}
// 发送方的 sendReq 指向岗位页：这一页是沟通页，URL 对不上，绝不能走 sendReq 分支
window.__store.sendReq = { url: 'https://www.zhipin.com/job_detail/aaa111.html?lid=x', text: 'REQ-岗位页的文本', id: 'aaa111', ts: Date.now() };
window.__store.cfg = { autoSend: true, autoOpenChat: true, autoCloseDetail: false,
  apiBase: 'https://api.test.local/v1', apiKey: 'sk-test-1234567890', model: 'test-model' };
window.__store.drafts = {}; window.__store.stats = { sent: 0 };`;

const hopAsserts = String.raw`
var R = [];
function add(n, p, x) { R.push({ name: n, pass: !!p, extra: x == null ? '' : String(x) }); }
function q(s) { return document.querySelector(s); }
function waitFor(fn, ms) {
  return new Promise(function (res) {
    var t0 = Date.now();
    (function loop() { var v = fn(); if (v) return res(v);
      if (Date.now() - t0 > (ms || 4000)) return res(null); setTimeout(loop, 40); })();
  });
}
function hopSS() { try { return sessionStorage.getItem('bgGreetHop'); } catch (e) { return 'ERR'; } }
async function run() {
  var c = window.__case;
  if (c === 'stale') {
    var gone = await waitFor(function () { return hopSS() === null && !window.__store.sendHop; }, 8000);
    add('过期的接力牌作废（不发、不写回执）', !!gone && window.__sent.length === 0 && !window.__store.sendRes,
      JSON.stringify({ ss: hopSS(), res: window.__store.sendRes, sent: window.__sent.length }));
    add('作废后照常给用户建面板（这一页不是脚本派来的）', !!q('#bgPanel'));
    add('运行期无未捕获错误', window.__errors.length === 0, window.__errors.join(' ;; '));
    return;
  }
  if (c === 'wrong') {
    var res = await waitFor(function () { return (window.__store.sendRes || {}).zzz999; }, 30000);
    add('认不出当前会话就停手，一个字都不发', window.__sent.length === 0, JSON.stringify(window.__sent).slice(0, 60));
    add('停手也不往输入框里填东西（免得用户一按回车就发错人）', String(window.chatVal()).length === 0, JSON.stringify(String(window.chatVal()).slice(0, 20)));
    add('停手也要给发送方明确回执（不能让它干等到超时）', !!res && res.ok === false, JSON.stringify(res).slice(0, 120));
    add('回执理由写清是「认不出会话」而不是「没找到输入框」', !!res && /认不出|会话/.test(res.why || ''), res ? String(res.why).slice(0, 40) : '无回执');
    add('接力牌用完就销毁（刷新这一页不会又发一条）', hopSS() === null && !window.__store.sendHop, String(hopSS()));
    add('全程没误点「发送图片」上传控件', window.__fileClicks === 0, String(window.__fileClicks));
    add('运行期无未捕获错误', window.__errors.length === 0, window.__errors.join(' ;; '));
    return;
  }
  if (c === 'fill' || c === 'notitle') {
    var lbl = c === 'fill' ? '半自动接力' : '职位名拿不到时';
    var res2 = await waitFor(function () { return (window.__store.sendRes || {}).aaa111; }, 30000);
    add(lbl + '：一个字都没发出去（没点发送、没回车）', window.__sent.length === 0, JSON.stringify(window.__sent).slice(0, 60));
    add(lbl + '：招呼语已经填进沟通页输入框', window.chatVal() === 'HOP-接力招呼语', JSON.stringify(String(window.chatVal()).slice(0, 30)));
    add(lbl + '：「发送」按钮已解禁，就差用户点一下', !/disabled/.test(q('#sendBtn').className), q('#sendBtn').className);
    add(lbl + '：回执是「只填没发」，不是发送成功', !!res2 && res2.ok === false && res2.filled === true, JSON.stringify(res2).slice(0, 120));
    add(lbl + '：牌用完即销毁', hopSS() === null && !window.__store.sendHop, String(hopSS()));
    add(lbl + '：这一页不建面板，但也不自动关（等你去点发送）', !q('#bgPanel'));
    add('运行期无未捕获错误', window.__errors.length === 0, window.__errors.join(' ;; '));
    return;
  }
  var sent = await waitFor(function () { return window.__sent.length > 0; }, 30000);
  add('跳转后的沟通页自己把招呼语发出去了（接力后半程）', !!sent && window.__sent[0] === 'HOP-接力招呼语', JSON.stringify(window.__sent).slice(0, 60));
  add('发的是接力牌里那条文本，不是 sendReq 里的岗位页文本', !!sent && window.__sent[0] !== 'REQ-岗位页的文本', '');
  add('沟通页上确实没有任何 job_detail 链接（和实测一致，旧版拿它当身份证据，真站点永远命中不了）',
    document.querySelectorAll('a[href*="job_detail"]').length === 0, document.querySelectorAll('a[href*="job_detail"]').length + ' 个');
  if (c === 'dirty') {
    add('这一例没有导航 URL 可依据，纯靠页面上的职位名确认',
      window.__nav.indexOf('?') < 0 && !/jobId=/.test(window.__nav), String(window.__nav).slice(0, 44));
    add('岗位名混进「[ 上海·浦东新区 ]」也认得出来（用户日志里失败的就是这一条）', !!sent, 'sent=' + window.__sent.length);
  }
  if (c === 'ok') {
    add('导航 URL 里的 jobId 对得上时，不必依赖职位名（SPA 洗地址栏也认得出）',
      /jobId=aaa111/.test(window.__nav), String(window.__nav).slice(0, 44));
  }
  var res3 = await waitFor(function () { return (window.__store.sendRes || {}).aaa111; }, 10000);
  add('回执按 jobId 写回，url 带的是岗位页地址（发送方据此认领）',
    !!res3 && res3.ok === true && res3.jobId === 'aaa111' && res3.url === 'https://www.zhipin.com/job_detail/aaa111.html?lid=x',
    JSON.stringify(res3).slice(0, 120));
  add('回执写明发送方式', !!res3 && /button|enter/.test(res3.how || ''), res3 ? String(res3.how) : '无回执');
  add('接力牌用完就销毁（用户之后自己开沟通页不会被偷发）', hopSS() === null && !window.__store.sendHop, String(hopSS()));
  add('沟通页这一半不建面板', !q('#bgPanel'));
  add('点的是解禁后的「发送」按钮，没误点上传控件', window.__fileClicks === 0, 'fileClicks=' + window.__fileClicks);
  add('运行期无未捕获错误', window.__errors.length === 0, window.__errors.join(' ;; '));
}
function render() {
  var bad = R.filter(function (r) { return !r.pass; }).length;
  document.getElementById('rows').innerHTML = R.map(function (r) {
    return '<tr><td>[' + window.__case + '] ' + r.name + '</td><td class="' + (r.pass ? 'pass">PASS' : 'fail">FAIL') + '</td><td class="extra">' +
      String(r.extra).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</td></tr>';
  }).join('');
  document.getElementById('sum').innerHTML = bad ? '<span class="fail">' + bad + ' 项失败</span> / 共 ' + R.length + ' 项' : '<span class="pass">全部 ' + R.length + ' 项通过</span>';
  window.__RESULT = R;
}
(async function () {
  try { await run(); }
  catch (e) { add('测试脚本自身异常', false, e.message + ' @ ' + String(e.stack || '').split('\n')[1]); }
  render();
})();`;

const html3 = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>发送接力测试</title>
<style>
body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:20px 20px 140px}
#site{position:fixed;left:0;top:0;width:100%;height:100%;background:#fff;z-index:1}
.chat-list{position:absolute;left:0;top:0;bottom:0;width:22%;border-right:1px solid #ddd;padding:8px}
.conv{padding:8px;font-size:13px;color:#333}
.chat-conversation{position:absolute;left:32%;right:0;top:0;bottom:0;padding:8px}
.chat-head{font-size:14px;color:#222}
.chat-input{display:block;width:60%;height:60px;border:1px solid #ccc;margin-top:30%}
#sendBtn{margin-top:6px}
.pass{color:#1c8a45;font-weight:600}.fail{color:#c8402f;font-weight:600}
.extra{color:#7a8698;font-size:12px;word-break:break-all}
table{border-collapse:collapse;width:100%;position:relative;z-index:2;background:#fff}
th,td{border-bottom:1px solid #eee;padding:5px 8px;text-align:left;vertical-align:top}
#sum{font-size:16px;margin:8px 0;position:relative;z-index:2;background:#fff}
h3{position:relative;z-index:2;background:#fff}
</style></head><body>
<h3>BOSS 打招呼助手 · 「点继续沟通整页跳转」的发送接力测试（?case= 切换情形）</h3>
<div id="sum">运行中…</div>
<table><thead><tr><th style="width:38%">断言</th><th style="width:8%">结果</th><th>实际值</th></tr></thead><tbody id="rows"></tbody></table>
${hopFixture}
<script>${stubs}<\/script>
<script>${hopSeed}<\/script>
<script>/* ==== .user.js 原文 ==== */
${src}
<\/script>
<script>${hopAsserts}<\/script>
</body></html>
`;

fs.writeFileSync(path.join(root, 'test', 'ui-hop.html'), html3);

/* ==========================================================================
 * 第四个页面：「被脚本开出来抓详情」的岗位详情页（用户截图里的图2 那一页）。
 *   抓详情从来不是点「继续沟通/立即沟通」—— 那颗按钮一点就是 friend/add + 整页跳沟通页，
 *   详情页入口是列表卡片标题那个链接（job.url）。所以这一页要证明的是：
 *   认牌（pendingDetails 里有自己）→ 抓 JD 正文 → 写进油猴存储 → 销账 → 自动关标签，
 *   全程一个按钮都不点、一个字都不填。
 * ========================================================================== */
const detailFixture = String.raw`
<div id="site">
  <div class="job-banner"><div class="job-primary">
    <h1 class="name">28届后端实习生-示例短视频</h1><span class="salary">200-250元/天</span>
    <span class="city">上海</span><span class="week">4天/周·3个月</span><span class="degree">本科</span>
    <div class="op-wrap"><a class="btn btn-startchat" id="greetBtn" href="javascript:;" redirect-url="/web/geek/chat?id=bb1&amp;jobId=aaa111&amp;securityId=s1" data-isfriend="true">继续沟通</a></div>
  </div></div>
  <div class="job-detail">
    <h2 class="title">职位描述：</h2>
    <div class="job-sec-text">日常实习：面向全体在校生，为符合要求的同学提供为期 3 个月及以上的项目实践机会。<br>1、负责示例电商订单与营销方向的服务端开发与系统调优；<br>2、参与制定代码规范、测试规范；<br>3、协助团队攻克高并发、数据隔离等技术难关。JD-MARKER-7731</div>
    <h2 class="title">任职要求：</h2>
    <div class="job-sec-text">1、本科及以上学历在读，计算机相关专业；<br>2、精通 Java、MySQL、Spring，熟悉 Redis 与消息队列；<br>3、一周至少到岗 4 天，可实习 5 个月。</div>
  </div>
</div>
<div id="chatBox" style="display:none">
  <div class="chat-tool">
    <div class="chat-send-img" role="button" title="发送图片" id="imgBtn"><input type="file" id="fileIn" accept="*.gif;*.jpg;*.png"><span>发送</span></div>
  </div>
  <div class="chat-input" contenteditable="true"></div>
  <button class="btn-v2 btn-sure-v2 btn-send disabled" id="sendBtn">发送</button>
</div>`;

// 等价于「面板侧刚 GM_setValue('pendingDetails') + GM_openInTab(job.url)」，
// 而且 job.url 是去掉 query 的裸地址（抓取时就这么存），所以这里必须用同一个 normalize 后的值。
const detailSeed = String.raw`
window.__store.cfg = { autoSend: false, autoOpenChat: false, autoCloseDetail: true,
  apiBase: 'https://api.test.local/v1', apiKey: 'sk-test-1234567890', model: 'test-model' };
window.__CUR = location.href.split('?')[0].split('#')[0];
window.__store.jobs = [{ id: 'aaa111', title: '28届后端实习生-示例短视频', url: window.__CUR, sel: true }];
window.__store.pendingDetails = [{ id: 'aaa111', url: window.__CUR, ts: Date.now() }];
window.__store.details = {};
window.__store.drafts = {};
window.__store.stats = { sent: 0 };
// headless 里 window.close() 是空操作，换成计数器才能断言「用完自动关掉」真的发生了
try {
  Object.defineProperty(window, 'close', { configurable: true, writable: true,
    value: function () { window.__closed = (window.__closed || 0) + 1; } });
} catch (e) { window.__closeErr = String(e && e.message); }`;

const detailAsserts = String.raw`
var R = [];
function add(n, p, x) { R.push({ name: n, pass: !!p, extra: x == null ? '' : String(x) }); }
function q(s) { return document.querySelector(s); }
function waitFor(fn, ms) {
  return new Promise(function (res) {
    var t0 = Date.now();
    (function loop() { var v = fn(); if (v) return res(v);
      if (Date.now() - t0 > (ms || 4000)) return res(null); setTimeout(loop, 40); })();
  });
}
async function run() {
  // 「别的标签页在这一页加载之后又写了 details」：必须整体换掉顶层那个对象 —— 桩里的存储是
  // 按引用存的，只往 __store.details 里加一个键会连这页内存里那份一起改，就测不出整块盖回去了。
  // 抓详情那一步要等 rnd(2000,3500) 才开始，这段同步代码一定排在它前面。
  window.__store.details = { other999: { id: 'other999', text: '别的标签页刚抓回来的 JD FOREIGN-JD-MARKER', title: '别处的岗位', ts: Date.now() } };
  var d = await waitFor(function () { return (window.__store.details || {}).aaa111; }, 15000);
  add('详情页认出自己是被脚本开出来抓详情的（不建面板，免得用户以为要在这儿操作）', !q('#bgPanel'));
  add('这一页写自己那条 JD 时，别的标签页刚写进来的那条不会被整块盖掉（多标签抓详情不互相踩）',
    !!(window.__store.details || {}).other999,
    JSON.stringify(Object.keys(window.__store.details || {})));
  add('JD 正文抓到了（职位描述 + 任职要求都在）', !!d && /职位描述/.test(d.text) && /任职要求/.test(d.text) && d.text.length > 120,
    d ? d.text.length + ' 字' : '没抓到详情');
  add('抓的是正文容器，没把导航/侧栏一起吞进提示词', !!d && !/公司基本|下载APP|无障碍专区/.test(d.text),
    d ? d.text.slice(0, 36) : '无');
  add('薪资这类头部字段不在正文里（所以列表卡片那份信息不能丢）', !!d && !/200-250元\/天/.test(d.text),
    d ? (/200-250/.test(d.text) ? '正文里居然有薪资' : '确认没有') : '无');
  add('标题取 document.title 且不被岗位名里的连字符腰斩', !!d && d.title === '28届后端实习生-示例短视频 _ 上海 200-250元/天',
    d ? String(d.title) : '无');
  add('抓完把待抓队列里自己那条销账（不留地雷，下次自己打开这页不会又自动抓）',
    (window.__store.pendingDetails || []).every(function (p) { return p.id !== 'aaa111'; }),
    JSON.stringify(window.__store.pendingDetails || []));
  await waitFor(function () { return window.__closed > 0; }, 8000);
  add('autoCloseDetail 开着，抓完把这个后台标签收掉', window.__closed > 0, 'closed=' + window.__closed + ' ' + (window.__closeErr || ''));
  add('抓详情这一步一个按钮都没点（没碰「继续沟通」，也没误点上传控件）',
    window.__greetClicks === 0 && window.__wrapClicks === 0 && window.__fileClicks === 0,
    'greet=' + window.__greetClicks + ' wrap=' + window.__wrapClicks + ' file=' + window.__fileClicks);
  add('也没往聊天输入框里填任何东西', !String(q('.chat-input').textContent || '').trim(), String(q('.chat-input').textContent).slice(0, 30));
  add('没发出任何大模型请求（抓详情只是抓）',
    window.__reqs.filter(function (r) { return /\/chat\/completions$/.test(r.url); }).length === 0,
    'reqs=' + window.__reqs.length);
  add('页面上任何可见文本都不含 API Key', document.body.innerText.indexOf('sk-test-1234567890') < 0, '');
  add('运行期无未捕获错误', window.__errors.length === 0, window.__errors.join(' ;; '));
}
function render() {
  var bad = R.filter(function (r) { return !r.pass; }).length;
  document.getElementById('rows').innerHTML = R.map(function (r) {
    return '<tr><td>' + r.name + '</td><td class="' + (r.pass ? 'pass">PASS' : 'fail">FAIL') + '</td><td class="extra">' +
      String(r.extra).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</td></tr>';
  }).join('');
  document.getElementById('sum').innerHTML = bad ? '<span class="fail">' + bad + ' 项失败</span> / 共 ' + R.length + ' 项' : '<span class="pass">全部 ' + R.length + ' 项通过</span>';
  window.__RESULT = R;
}
(async function () {
  try { await run(); }
  catch (e) { add('测试脚本自身异常', false, e.message + ' @ ' + String(e.stack || '').split('\n')[1]); }
  render();
})();`;

const html4 = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>28届后端实习生-示例短视频 _ 上海 200-250元/天 - BOSS直聘</title>
<style>
body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:20px 20px 140px}
#chatBox{position:fixed;left:20px;bottom:20px;width:360px;background:#f2f6ff;border:1px solid #cfe0ff;padding:8px}
.pass{color:#1c8a45;font-weight:600}.fail{color:#c8402f;font-weight:600}
.extra{color:#7a8698;font-size:12px;word-break:break-all}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #eee;padding:5px 8px;text-align:left;vertical-align:top}
#sum{font-size:16px;margin:8px 0}
</style></head><body>
<h3>BOSS 打招呼助手 · 「被开出来抓详情」的岗位详情页测试（图2 那一页）</h3>
<div id="sum">运行中…</div>
<table><thead><tr><th style="width:38%">断言</th><th style="width:8%">结果</th><th>实际值</th></tr></thead><tbody id="rows"></tbody></table>
${detailFixture}
<script>${stubs}<\/script>
<script>${detailSeed}<\/script>
<script>/* ==== .user.js 原文 ==== */
${src}
<\/script>
<script>${detailAsserts}<\/script>
</body></html>
`;

fs.writeFileSync(path.join(root, 'test', 'ui-detail.html'), html4);

/* ==========================================================================
 * 第五个页面：发送路线 A ——「在列表页那张卡片上点沟通按钮」（v0.5.0）
 *   用户实测反馈：旧路线一次发送要开一趟详情页才够到沟通按钮，白等一页。收藏/感兴趣列表
 *   每张卡片右上角本来就有「继续沟通 / 立即沟通」（悬停才显示），点它一步到沟通页。
 *   这一页演的就是「脚本自己开出来的那个列表页标签」，用 ?case= 分情形：
 *     ok          卡片在首屏 -> 认出这张卡片 -> 悬停 -> 点它自己那颗按钮 -> 填 -> 发
 *     lazy        列表页懒加载：滚下去卡片才进 DOM
 *     absent      滚到底也没有这张卡片 -> 回执要「退回详情页入口」，一个字都不发
 *     noentry     卡片在、但卡片里没有沟通按钮 -> 同上
 *     foreign     卡片没按钮，邻卡那颗又没带 redirect-url（比不出 jobId）-> 越界找按钮的边界必须挡住它
 *     wrongentry  卡片里那颗按钮的 redirect-url 指向另一个 jobId -> 停手，且不许换入口重试
 *     stale-tab   这是用户十分钟前就开着的列表页（没有 #bgSend 标记、加载时间早于请求）-> 绝不认领
 *     fresh-tab   危险的那种：用户在发送途中自己新开/刷新的列表页，比请求还新但没有标记 -> 绝不认领
 *     stale-mark  反过来：URL 上带着上一条留下的 #bgSend 标记，可这一页比这次请求还老 -> 绝不认领
 *     navmark     站点用 replaceState 把 hash 洗掉了，只剩导航记录里的标记 -> 照样认领并发送
 *     claimed     请求已被别的标签页认领 -> 不重复执行
 *     fill        半自动：走到沟通页只填不发
 *   headless 里没法真做整页跳转，所以点按钮后「就地换成沟通页版面」，并把那一跳的 URL
 *   写进导航计时桩 —— 会话身份确认走的证据链和生产一致（生产上跳转那一半由 ui-hop 那套验）。
 * ========================================================================== */
const listSendFixture = String.raw`
<div id="site">
  <div class="job-list-box">
    <!-- 目标卡片照用户截图的真实形状搭：沟通按钮在卡片右上角那一行，和岗位标题不在同一个块里；
         正文那一块的字数够 findCard 停在 .info-primary 上 —— 于是「往上找按钮」这条路径真的被走到。 -->
    <div class="job-card-wrap" data-job="aaa111">
      <div class="job-card-header"><div class="op-list">
        <div class="btn btn-startchat-wrap" style="display:none"><a class="btn btn-startchat card-chat" data-job="aaa111" href="javascript:;" redirect-url="/web/geek/chat?id=cc1&jobId=aaa111&securityId=s1" data-isfriend="true">继续沟通</a></div>
        <div class="btn btn-fav-wrap" style="display:none"><a class="btn btn-fav card-fav" data-job="aaa111" href="javascript:;">取消兴趣</a></div>
      </div></div>
      <div class="job-card-body"><div class="info-primary">
      <div class="job-name"><a class="job-title-link" href="https://www.zhipin.com/job_detail/aaa111.html">28届后端实习生-示例短视频 [ 上海·浦东新区 ]</a></div>
      <div class="salary-wrap"><span class="salary">200-250元/天</span></div>
      <div class="company-wrap"><a class="company-name" href="https://www.zhipin.com/gongsi/example.html">示例网络科技有限公司</a></div>
      <div class="company-location">上海·浦东新区</div>
      <div class="tag-list"><span>Java</span><span>MySQL</span><span>Spring</span><span>Redis</span><span>消息队列</span><span>在校/应届</span><span>本科</span><span>4天/周</span><span>3个月以上</span></div>
      <div class="job-desc">岗位职责：负责短视频业务的服务端开发与系统调优，参与代码规范与测试规范建设，协助攻克高并发问题。</div>
      </div></div>
    </div>
    <div class="job-card-wrap" data-job="bbb222"><div class="job-card-body"><div class="info-primary">
      <div class="job-name"><a class="job-title-link" href="https://www.zhipin.com/job_detail/bbb222.html">全栈开发实习生 [ 成都·武侯区 ]</a></div>
      <div class="salary-wrap"><span class="salary">150-180元/天</span></div>
      <div class="company-wrap"><a class="company-name" href="https://www.zhipin.com/gongsi/example2.html">示例网络安全有限公司</a></div>
      <div class="company-location">成都·武侯区</div>
      <div class="tag-list"><span>Vue</span><span>Go</span><span>在校/应届</span><span>本科</span><span>5天/周</span></div>
      <div class="op-list">
        <div class="btn btn-startchat-wrap" style="display:none"><a class="btn btn-startchat card-chat" data-job="bbb222" href="javascript:;" redirect-url="/web/geek/chat?id=cd2&jobId=bbb222&securityId=s2" data-isfriend="false">立即沟通</a></div>
        <div class="btn btn-fav-wrap" style="display:none"><a class="btn btn-fav card-fav" data-job="bbb222" href="javascript:;">取消兴趣</a></div>
      </div>
    </div></div></div>
    <div class="job-card-wrap" data-job="ccc333"><div class="job-card-body"><div class="info-primary">
      <div class="job-name"><a class="job-title-link" href="https://www.zhipin.com/job_detail/ccc333.html">Agent实习开发工程师 [ 上海·长宁区 ]</a></div>
      <div class="salary-wrap"><span class="salary">250-300元/天</span></div>
      <div class="company-wrap"><a class="company-name" href="https://www.zhipin.com/gongsi/example3.html">示例出行集团有限公司</a></div>
      <div class="company-location">上海·长宁区</div>
      <div class="tag-list"><span>Python</span><span>LLM</span><span>在校/应届</span><span>本科</span><span>4天/周</span></div>
      <div class="op-list">
        <div class="btn btn-startchat-wrap" style="display:none"><a class="btn btn-startchat card-chat" data-job="ccc333" href="javascript:;" redirect-url="/web/geek/chat?id=ce3&jobId=ccc333&securityId=s3" data-isfriend="false">立即沟通</a></div>
        <div class="btn btn-fav-wrap" style="display:none"><a class="btn btn-fav card-fav" data-job="ccc333" href="javascript:;">取消兴趣</a></div>
      </div>
    </div></div></div>
  </div>
  <div id="spacer"></div>
  <div id="chatBox" style="display:none">
    <div class="chat-conversation"><div class="chat-head"><span class="position-name">28届后端实习生-示例短视频</span><span class="salary">200-250元/天</span></div>
      <div class="message-controls"><div class="chat-im chat-editor"><div class="editor-container">
        <div class="chat-tool"><div class="chat-send-img" role="button" title="发送图片" id="imgBtn"><input type="file" id="fileIn" accept="*.gif;*.jpg;*.png"><span>发送</span></div></div>
        <div class="chat-input" contenteditable="true"></div>
      </div><button class="btn-v2 btn-sure-v2 btn-send disabled" id="sendBtn">发送</button></div></div>
    </div>
  </div>
</div>`;

const listSendSeed = String.raw`
// 注意 case 名里有连字符（stale-tab），正则别只写 \w+
window.__case = (location.search.match(/case=([\w-]+)/) || [])[1] || 'ok';
window.__nav = location.href;                                  // 还没点按钮：这一页不是沟通页
performance.getEntriesByType = function (t) { return t === 'navigation' ? [{ name: window.__nav }] : []; };
window.__cardClicks = []; window.__favClicks = 0; window.__hovers = 0; window.__scrolls = 0;
// 绑一颗卡片上的沟通按钮（懒加载补进来的那张也得绑 —— cloneNode 不复制监听器，
// 少了这一步，点了等于没点，测试会以为脚本没点着）
function bindChatBtn(a) {
  if (!a || a.__bound) return;
  a.__bound = 1;
  a.addEventListener('click', function () {
    window.__cardClicks.push(a.getAttribute('data-job'));
    // 真实站点：点下去整页跳进沟通页。这里就地换成沟通页版面，并把「那一跳的 URL」记进导航桩，
    // 让会话身份确认拿到和生产一样的证据（导航记录里的 jobId）。
    window.__nav = 'https://www.zhipin.com/web/geek/chat?id=cc1&jobId=' + a.getAttribute('data-job') + '&securityId=s1';
    document.getElementById('chatBox').style.display = 'block';
  });
}
[].forEach.call(document.querySelectorAll('.card-chat'), bindChatBtn);
function bindFavBtn(a) {
  if (!a || a.__fav) return;
  a.__fav = 1;
  a.addEventListener('click', function () { window.__favClicks++; });   // 「取消兴趣」点一下收藏就没了
}
[].forEach.call(document.querySelectorAll('.card-fav'), bindFavBtn);
document.addEventListener('mouseover', function (e) {
  var t = e.target;
  if (t && t.classList && t.classList.contains('card-chat')) window.__hovers++;
}, true);
var BASE = location.href.split('#')[0];
var REQ_TS = Date.now();
if (window.__case === 'lazy') {
  // 懒加载：目标卡片本来不在 DOM 里，页面滚过一屏才插进来（真实列表页就是这样一批批出的）。
  // 这里用「轮询滚动位置」模拟站点的懒加载，不用 scroll 事件：本机 headless 实测
  // --virtual-time-budget 下 scrollTop 赋值能把 scrollY 改掉，但 scroll 事件一次都不派发，
  // 拿事件当触发器只会让测试假失败（探针写在 tmp/ 下，那个目录不进仓库，结论就记在这段注释里）。
  var host = document.querySelector('.job-list-box');
  var first = host.querySelector('[data-job="aaa111"]');
  var clone = first.cloneNode(true);
  host.removeChild(first);
  bindChatBtn(clone.querySelector('.card-chat'));       // 见上：cloneNode 不带监听器
  bindFavBtn(clone.querySelector('.card-fav'));
  window.__maxScrollY = 0;
  setInterval(function () {
    window.__maxScrollY = Math.max(window.__maxScrollY, window.scrollY);
    if (window.scrollY > 300 && !document.querySelector('[data-job="aaa111"]')) {
      host.appendChild(clone); window.__scrolls++;
    }
  }, 200);
}
if (window.__case === 'absent') {
  document.querySelector('.job-list-box').removeChild(document.querySelector('[data-job="aaa111"]'));
}
if (window.__case === 'noentry') {
  var card0 = document.querySelector('[data-job="aaa111"]');
  card0.querySelector('.op-list').parentNode.removeChild(card0.querySelector('.op-list'));
}
if (window.__case === 'foreign') {
  // 最危险的一种改版：这一张卡片上没有按钮，脚本「往上找几层」走到装着所有卡片的那一层时，
  // 旁边那张卡片的按钮又没带 redirect-url（拿不出 jobId 来比对，那道 jobId 闸门就管不着了）。
  // 挡住它的只有 cardIsOnlyThisJob 这条边界：某一层里出现了别的岗位的链接，就绝不往上。
  // 少了这条边界，实测表现是「把 A 岗位的话发进了 B 的 HR」——所以这颗按钮的点击数才是本 case 的主角。
  var cfd = document.querySelector('[data-job="aaa111"]');
  cfd.querySelector('.op-list').parentNode.removeChild(cfd.querySelector('.op-list'));
  document.querySelector('[data-job="bbb222"] .card-chat').removeAttribute('redirect-url');
}
if (window.__case === 'wrongentry') {
  // 站点/改版把按钮和岗位对错了：卡片链接是 aaa111，按钮的 redirect-url 却写着 bbb222
  var bad = document.querySelector('[data-job="aaa111"] .card-chat');
  bad.setAttribute('redirect-url', '/web/geek/chat?id=cd2&jobId=bbb222&securityId=s2');
}
if (window.__case === 'stale-tab') {
  // 用户十分钟之前自己开的列表页：加载时间远早于这次请求，也没有 #bgSend= 标记 -> 绝不能认领
  try { Object.defineProperty(performance, 'timeOrigin', { value: Date.now() - 600000, configurable: true }); } catch (e) {}
} else if (window.__case === 'fresh-tab') {
  // 危险的那种：用户在发送进行中的这 60 秒里自己新开（或刷新）了一个列表页标签。
  // 它的加载时间一定晚于请求时间 —— 光看「新不新」必然通过，所以认领还额外要求 URL 上有 #bgSend 标记。
  // 这一页没有标记，一个字都不许动，更不许把他正看着的那一页跳走。
} else if (window.__case === 'stale-mark') {
  // 反过来：这一页 URL 上带着 #bgSend 标记（用户从上一条标签页复制地址开的，标记是上一次发送留下的），
  // 但它比这次请求还老 -> 同样不许认领。钉住「标记 + 够新」两个条件缺一不可。
  location.hash = '#bgSend=' + String('aaa111').slice(0, 24);
  try { Object.defineProperty(performance, 'timeOrigin', { value: Date.now() - 600000, configurable: true }); } catch (e) {}
} else if (window.__case === 'navmark') {
  // 站点是 SPA，加载后用 history.replaceState 把 hash 洗掉了 -> 当前地址上看不到标记。
  // 但「那一跳的原始 URL」还留在导航计时记录里（沟通页认身份用的是同一套证据），照样要认领。
  window.__nav = BASE + '#bgSend=' + String('aaa111').slice(0, 24);
} else {
  location.hash = '#bgSend=' + String('aaa111').slice(0, 24);   // 脚本开出来时 URL 上带的标记
}
window.__store.sendReq = {
  via: 'list', listUrl: BASE, url: 'https://www.zhipin.com/job_detail/aaa111.html', id: 'aaa111',
  text: 'LIST-列表入口招呼语', title: '28届后端实习生-示例短视频', company: '示例网络科技有限公司',
  fillOnly: window.__case === 'fill', ts: REQ_TS
};
if (window.__case === 'claimed') window.__store.sendClaim = { ts: REQ_TS, by: '别的标签页' };
window.__store.cfg = { autoSend: true, autoOpenChat: true, sendViaList: true, autoCloseDetail: false,
  apiBase: 'https://api.test.local/v1', apiKey: 'sk-test-1234567890', model: 'test-model' };
window.__store.jobs = []; window.__store.details = {}; window.__store.drafts = {}; window.__store.stats = { sent: 0 };`;

const listSendAsserts = String.raw`
var R = [];
function add(n, p, x) { R.push({ name: n, pass: !!p, extra: x == null ? '' : String(x) }); }
function q(s) { return document.querySelector(s); }
function waitFor(fn, ms) {
  return new Promise(function (res) {
    var t0 = Date.now();
    (function loop() { var v = fn(); if (v) return res(v);
      if (Date.now() - t0 > (ms || 4000)) return res(null); setTimeout(loop, 40); })();
  });
}
function res() { return (window.__store.sendRes || {}).aaa111; }
function hops() { try { return sessionStorage.getItem('bgGreetHop'); } catch (e) { return 'ERR'; } }
async function run() {
  var c = window.__case;

  var refuseLabels = {
    'stale-tab': '用户早就开着的列表页',
    'fresh-tab': '用户在发送途中刚打开的列表页（没有 #bgSend 标记）',
    'stale-mark': '带着上一条标记、但比这次请求还老的那一页',
    'claimed': '请求已被别的标签页认领'
  };
  if (refuseLabels[c]) {
    var lbl = refuseLabels[c];
    await waitFor(function () { return !!q('#bgPanel'); }, 8000);
    await new Promise(function (r) { setTimeout(r, 3000); });
    add(lbl + '：绝不认领这次发送（一颗卡片按钮都不点）', window.__cardClicks.length === 0, JSON.stringify(window.__cardClicks));
    add(lbl + '：不写任何回执（发送方该等它自己那份超时）', !window.__store.sendRes, JSON.stringify(window.__store.sendRes || null).slice(0, 80));
    add(lbl + '：这一页照常给用户建面板', !!q('#bgPanel'));
    add(lbl + '：也没往输入框里填字', String(window.chatVal()).length === 0, JSON.stringify(String(window.chatVal()).slice(0, 20)));
    add('运行期无未捕获错误', window.__errors.length === 0, window.__errors.join(' ;; '));
    return;
  }

  if (c === 'absent' || c === 'noentry' || c === 'foreign') {
    var r0 = await waitFor(function () { return res(); }, 40000);
    var l0 = c === 'absent' ? '列表页滚到底也没有这张卡片'
      : c === 'foreign' ? '这张卡片没按钮、邻卡按钮又没有 redirect-url（不许越界去点别人的）'
      : '卡片上没有沟通按钮';
    add(l0 + '：一个字都不发', window.__sent.length === 0, JSON.stringify(window.__sent).slice(0, 60));
    add(l0 + '：一颗卡片按钮都没点（不拿别的卡片凑数）', window.__cardClicks.length === 0, JSON.stringify(window.__cardClicks));
    add(l0 + '：回执说清失败并标记要退回详情页入口', !!r0 && r0.ok === false && r0.needJobTab === true, JSON.stringify(r0).slice(0, 140));
    add(l0 + '：理由写的是人话（不是 undefined）', !!r0 && /列表页|卡片|按钮/.test(r0.why || ''), r0 ? String(r0.why).slice(0, 40) : '无回执');
    add(l0 + '：这一页不建面板', !q('#bgPanel'));
    add('运行期无未捕获错误', window.__errors.length === 0, window.__errors.join(' ;; '));
    return;
  }

  if (c === 'wrongentry') {
    var r1 = await waitFor(function () { return res(); }, 30000);
    add('卡片链接是这条岗位、按钮却指向别的 jobId：一个字都不发', window.__sent.length === 0, JSON.stringify(window.__sent).slice(0, 60));
    add('连点都不点（不靠「点了再看会话」赌一把）', window.__cardClicks.length === 0, JSON.stringify(window.__cardClicks));
    add('回执把「对不上」写清楚', !!r1 && r1.ok === false && /jobId|对不上/.test(r1.why || ''), r1 ? String(r1.why).slice(0, 50) : '无回执');
    add('这种不一致不许换个入口再试一次（needJobTab 不为真）', !!r1 && !r1.needJobTab, JSON.stringify(r1).slice(0, 120));
    add('运行期无未捕获错误', window.__errors.length === 0, window.__errors.join(' ;; '));
    return;
  }

  var done = await waitFor(function () { return res(); }, 45000);
  if (c === 'fill') {
    add('半自动：走到沟通页一个字都没发出去', window.__sent.length === 0, JSON.stringify(window.__sent).slice(0, 60));
    add('半自动：招呼语已填进沟通页输入框', window.chatVal() === 'LIST-列表入口招呼语', JSON.stringify(String(window.chatVal()).slice(0, 24)));
    add('半自动：「发送」按钮已解禁，就差用户点一下', !/disabled/.test(q('#sendBtn').className), q('#sendBtn').className);
    add('半自动：回执是「只填没发」，不标已发送', !!done && done.ok === false && done.filled === true, JSON.stringify(done).slice(0, 120));
  } else {
    add('认出的正是这张卡片：只有目标岗位那颗沟通按钮被点了一次',
      window.__cardClicks.length === 1 && window.__cardClicks[0] === 'aaa111', JSON.stringify(window.__cardClicks));
    add('别的卡片的按钮一颗都没点（列表页每张卡片都有一颗，点错就把 A 的话发给 B 的 HR）',
      window.__cardClicks.indexOf('bbb222') < 0 && window.__cardClicks.indexOf('ccc333') < 0, JSON.stringify(window.__cardClicks));
    add('没点「取消兴趣」（点一下收藏就没了一条岗位）', window.__favClicks === 0, String(window.__favClicks));
    add('悬停事件补发过（站点靠 :hover 才显示这颗按钮）', window.__hovers >= 1, 'hovers=' + window.__hovers);
    add('display:none 的按钮也点着了（不因为看不见就跳过）', window.__cardClicks.length === 1, 'clicks=' + window.__cardClicks.length);
    add('招呼语真的发进了沟通页并点了发送', window.__sent.length === 1 && window.__sent[0] === 'LIST-列表入口招呼语', JSON.stringify(window.__sent).slice(0, 60));
    add('回执 ok 且按 jobId 写回（发送方据此认领）',
      !!done && done.ok === true && done.jobId === 'aaa111' && done.url === 'https://www.zhipin.com/job_detail/aaa111.html',
      JSON.stringify(done).slice(0, 140));
    add('认领记录写下的是这次请求（一个请求只让一个标签页执行）',
      !!window.__store.sendClaim && window.__store.sendClaim.ts === REQ_TS, JSON.stringify(window.__store.sendClaim || null));
    if (c === 'lazy') {
      add('懒加载：脚本自己把列表页滚下去了（不是等站点自己冒出来）', window.__maxScrollY > 300, 'maxScrollY=' + window.__maxScrollY);
      add('懒加载：滚过一屏才出现的卡片也找到了并点着了', window.__scrolls >= 1 && !!q('[data-job="aaa111"]'), 'scrolls=' + window.__scrolls);
    }
    if (c === 'navmark') {
      add('站点把地址上的 #bgSend 洗掉了：靠导航记录里的同一标记照样认领',
        location.hash.indexOf('bgSend=') < 0 && window.__cardClicks.length === 1, 'hash=' + location.hash + ' clicks=' + JSON.stringify(window.__cardClicks));
    }
    if (c === 'ok') {
      // 「认领只在 boot() 里判一次」才是「绝不在你正看着的那一页点」的真正保证：这一页已经跑完这次发送，
      // 之后再往存储里塞第二个请求（换个 ts，认领记录拦不住它），这一页也不许回头再点一遍。
      var before = window.__cardClicks.length;
      window.__store.sendReq = { via: 'list', listUrl: BASE, url: 'https://www.zhipin.com/job_detail/aaa111.html',
        id: 'aaa111', text: 'LIST-第二条不该被执行', title: '28届后端实习生-示例短视频',
        company: '示例网络科技有限公司', fillOnly: false, ts: Date.now() };
      await new Promise(function (r) { setTimeout(r, 3000); });
      add('已经开着的页面不会再认领后来的请求（boot 只判一次，不轮询）',
        window.__cardClicks.length === before && window.__sent.length === 1 &&
        String(window.chatVal()).indexOf('不该被执行') < 0,
        'clicks=' + JSON.stringify(window.__cardClicks) + ' sent=' + JSON.stringify(window.__sent).slice(0, 60));
    }
  }
  add('接力牌用完即销毁（用户之后自己开这个列表页不会被偷发）', !window.__store.sendHop && hops() === null, String(hops()));
  add('这一页不建面板（用户不会误以为要在这儿操作）', !q('#bgPanel'));
  add('全程没误点「发送图片」上传控件', window.__fileClicks === 0, String(window.__fileClicks));
  add('页面上任何可见文本都不含 API Key', document.body.innerText.indexOf('sk-test-1234567890') < 0, '');
  add('运行期无未捕获错误', window.__errors.length === 0, window.__errors.join(' ;; '));
}
function render() {
  var bad = R.filter(function (r) { return !r.pass; }).length;
  document.getElementById('rows').innerHTML = R.map(function (r) {
    return '<tr><td>[' + window.__case + '] ' + r.name + '</td><td class="' + (r.pass ? 'pass">PASS' : 'fail">FAIL') + '</td><td class="extra">' +
      String(r.extra).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</td></tr>';
  }).join('');
  document.getElementById('sum').innerHTML = bad ? '<span class="fail">' + bad + ' 项失败</span> / 共 ' + R.length + ' 项' : '<span class="pass">全部 ' + R.length + ' 项通过</span>';
  window.__RESULT = R;
}
(async function () {
  try { await run(); }
  catch (e) { add('测试脚本自身异常', false, e.message + ' @ ' + String(e.stack || '').split('\n')[1]); }
  render();
})();`;

const html5 = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>BOSS 打招呼助手 · 列表卡片入口发送测试</title>
<style>
body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:20px 20px 140px}
#spacer{height:2600px}
.job-card-wrap{border:1px solid #eee;padding:10px;margin:8px 0}
.job-name a{text-decoration:none;color:#222}
.op-list .btn{display:none}
.job-card-wrap:hover .op-list .btn{display:inline-block}
#chatBox{position:fixed;left:40%;right:20px;top:120px;background:#f2f6ff;border:1px solid #cfe0ff;padding:8px}
.chat-input{display:block;width:70%;height:60px;border:1px solid #ccc;margin-top:12px}
.pass{color:#1c8a45;font-weight:600}.fail{color:#c8402f;font-weight:600}
.extra{color:#7a8698;font-size:12px;word-break:break-all}
table{border-collapse:collapse;width:100%;position:relative;z-index:2;background:#fff}
th,td{border-bottom:1px solid #eee;padding:5px 8px;text-align:left;vertical-align:top}
#sum{font-size:16px;margin:8px 0;position:relative;z-index:2;background:#fff}
h3{position:relative;z-index:2;background:#fff}
</style></head><body>
<h3>BOSS 打招呼助手 · 「在列表卡片上点沟通按钮」这条发送路线（?case= 切换情形）</h3>
<div id="sum">运行中…</div>
<table><thead><tr><th style="width:38%">断言</th><th style="width:8%">结果</th><th>实际值</th></tr></thead><tbody id="rows"></tbody></table>
${listSendFixture}
<script>${stubs}<\/script>
<script>${listSendSeed}<\/script>
<script>/* ==== .user.js 原文 ==== */
${src}
<\/script>
<script>${listSendAsserts}<\/script>
</body></html>
`;

fs.writeFileSync(path.join(root, 'test', 'ui-listsend.html'), html5);

/* ==========================================================================
 * 第六个页面：脚本自己开出来的「生成器」标签页（v0.5.5）。
 *   ui-smoke 末尾那三组验的是面板这一半（写交接单、只看不干、失败退回本页、死了重派）；
 *   这一页验的是另外一半，也就是「生成不能被打断」真正落地的地方：
 *     · 认领的两道闸门 —— 地址上的 #bgExec 标记 + 这一页比交接单新，缺一不可
 *     · 心跳、标题、日志分开存、草稿带着自己算的指纹回存储
 *     · 「是否离开网站？」只武装在真的跑着这一轮的那一页上
 *     · 观众页的暂停/停止是指令，这一页真的压节奏、真的收手、收手后自己关
 *   用 ?case= 分八种情形，run.js 把同一个文件渲染八遍。
 * ========================================================================== */
const execFixture = String.raw`
<div id="site">
  <div class="job-list-box">
    <div class="job-card-wrap"><div class="job-card-body"><div class="info-primary">
      <div class="job-name"><a class="job-title-link" href="https://www.zhipin.com/job_detail/aaa111.html">示例后端实习生-甲</a></div>
      <div class="salary-wrap"><span class="salary">200-250元/天</span></div>
      <div class="company-wrap"><a class="company-name" href="https://www.zhipin.com/gongsi/example.html">示例网络科技有限公司</a></div>
      <div class="company-location">上海·浦东新区</div>
    </div></div></div>
    <div class="job-card-wrap"><div class="job-card-body"><div class="info-primary">
      <div class="job-name"><a class="job-title-link" href="https://www.zhipin.com/job_detail/bbb222.html">示例后端实习生-乙</a></div>
      <div class="salary-wrap"><span class="salary">150-180元/天</span></div>
      <div class="company-wrap"><a class="company-name" href="https://www.zhipin.com/gongsi/example2.html">示例网络安全有限公司</a></div>
      <div class="company-location">成都·武侯区</div>
    </div></div></div>
    <div class="job-card-wrap"><div class="job-card-body"><div class="info-primary">
      <div class="job-name"><a class="job-title-link" href="https://www.zhipin.com/job_detail/ccc333.html">示例后端实习生-丙</a></div>
      <div class="salary-wrap"><span class="salary">250-300元/天</span></div>
      <div class="company-wrap"><a class="company-name" href="https://www.zhipin.com/gongsi/example3.html">示例出行集团有限公司</a></div>
      <div class="company-location">上海·长宁区</div>
    </div></div></div>
  </div>
</div>
<div id="chatBox" style="display:none">
  <div class="chat-tool">
    <div class="chat-send-img" role="button" title="发送图片" id="imgBtn"><input type="file" id="fileIn" accept="*.gif;*.jpg;*.png"><span>发送</span></div>
  </div>
  <div class="chat-input" contenteditable="true"></div>
  <button class="btn-v2 btn-sure-v2 btn-send disabled" id="sendBtn">发送</button>
</div>`;

// 预置油猴存储，等价于「面板刚 GM_setValue('bgExec') 并 GM_openInTab 把这一页开出来」
const execSeed = String.raw`
window.__case = (location.search.match(/case=([\w-]+)/) || [])[1] || 'ok';
// 身份判定的第二道证据：导航计时里最初那一跳的完整地址（真实站点是 SPA，加载后常把 hash 洗掉）。
// 这里把它做成一个可读写的桩，navmark 那一种就是「当前地址没了、但这一跳的记录还在」。
window.__nav = location.href;
performance.getEntriesByType = function (t) { return t === 'navigation' ? [{ name: window.__nav }] : []; };
var TK = 'ex01aa22bb';                     // 这一轮那张一次性凭证
var TK_OLD = 'ex99zz88yy';                 // 上一轮留下的、已经作废的那一张
var REQ_TS = Date.now();                   // 面板写下交接单的那一刻
var IDS = (window.__case === 'stop' || window.__case === 'liveother')
  ? ['aaa111', 'bbb222', 'ccc333'] : ['aaa111', 'bbb222'];

if (window.__case === 'nomark') {
  // 用户自己开的普通一页：地址上没有标记
} else if (window.__case === 'stale-tab') {
  // 十分钟之前他自己开的列表页，地址里恰好还留着上一轮的标记：光看标记就会抢走
  location.hash = '#bgExec=' + TK;
  try { Object.defineProperty(performance, 'timeOrigin', { value: Date.now() - 600000, configurable: true }); } catch (e) {}
} else if (window.__case === 'stale-mark') {
  // 反过来：这一页够新，但地址上的标记是上一条复制来的旧凭证
  location.hash = '#bgExec=' + TK_OLD;
} else if (window.__case === 'navmark') {
  window.__nav = 'https://www.zhipin.com/web/geek/job-recommend#bgExec=' + TK;
} else if (window.__case !== 'nomark') {
  location.hash = '#bgExec=' + TK;         // 脚本开出来时地址上带的那张单
}

window.__store.bgExec = { token: TK, ts: REQ_TS, ids: IDS.slice(), claimed: '' };
if (window.__case === 'claimed') window.__store.bgExec.claimed = '别的页面的身份串';
if (window.__case === 'liveother') {
  // 另一页真在跑这一轮：心跳还是新鲜的（BATCH_LIVE_MS 之内）
  window.__store.bgBatch = { ids: IDS.slice(), autoSend: false, day: new Date().toISOString().slice(0, 10),
    tick: Date.now(), by: 'other-page-token', role: 'exec', started: Date.now() - 5000,
    gen: ['aaa111'], pause: false, stop: 0, respawn: 0 };
}

window.__store.jobs = [
  { id: 'aaa111', title: '示例后端实习生-甲', company: '示例网络科技有限公司', salary: '200-250元/天',
    city: '上海', url: 'https://www.zhipin.com/job_detail/aaa111.html', ts: REQ_TS },
  { id: 'bbb222', title: '示例后端实习生-乙', company: '示例网络安全有限公司', salary: '150-180元/天',
    city: '成都', url: 'https://www.zhipin.com/job_detail/bbb222.html', ts: REQ_TS },
  { id: 'ccc333', title: '示例后端实习生-丙', company: '示例出行集团有限公司', salary: '250-300元/天',
    city: '上海', url: 'https://www.zhipin.com/job_detail/ccc333.html', ts: REQ_TS }
];
window.__store.details = {};
['aaa111', 'bbb222', 'ccc333'].forEach(function (jid, k) {
  window.__store.details[jid] = { id: jid, title: '示例后端实习生-' + '甲乙丙'.charAt(k), ts: REQ_TS,
    text: '职位描述：\n负责订单补偿链路与核心链路降级。JD-EXEC-' + jid + '\n任职要求：\n精通 Java、Spring、MySQL，熟用 Redis 与消息队列。' };
});
window.__store.drafts = {};
window.__store.stats = { day: new Date().toISOString().slice(0, 10), sent: 0, generated: 0 };
window.__store.resumeText = '张三 求职意向：Java 后端。5 年后端经验，主导订单中台重构，' +
  '熟悉 Spring Boot、MySQL、Redis、消息队列，做过全链路压测与稳定性治理。';
window.__store.cfg = { apiBase: 'https://api.test.local/v1', apiKey: 'sk-test-1234567890', model: 'test-model',
  autoSend: false, bgExecutor: true, autoCloseDetail: true, genConcurrency: 1, maxPerDay: 60 };
// 每条生成拖 6~8 秒：要留出「跑一半的时候按暂停/停止」「跑一半的时候离开」的观察窗口
window.__genDelay = window.__case === 'stop' ? 8000 : (window.__case === 'ok' || window.__case === 'navmark' ? 6000 : 0);`;

const execAsserts = String.raw`
var R = [];
function add(n, p, x) { R.push({ name: n, pass: !!p, extra: x == null ? '' : String(x) }); }
function q(s) { return document.querySelector(s); }
function waitFor(fn, ms) {
  return new Promise(function (res) {
    var t0 = Date.now();
    (function loop() { var v = fn(); if (v) return res(v);
      if (Date.now() - t0 > (ms || 4000)) return res(null); setTimeout(loop, 40); })();
  });
}
function genReqs() { return window.__reqs.filter(function (r) { return /\/chat\/completions$/.test(r.url); }); }
function plan() { return window.__store.bgBatch || {}; }
function hnd() { return window.__store.bgExec || {}; }
function dr(id) { return (window.__store.drafts || {})[id] || {}; }
function exLog() { return String((window.__store.bgLogExec || []).join('\n')); }
function guardFired() {
  var ev = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}
async function run() {
  var c = window.__case;
  var refuse = {
    'nomark': '用户自己开的普通页（地址上没有 #bgExec 标记）',
    'stale-tab': '十分钟前就开着、地址里恰好留着上一轮标记的那一页',
    'stale-mark': '够新但标记是上一轮作废的那一张',
    'claimed': '交接单已经被别的生成器认领'
  };

  if (refuse[c]) {
    var wasClaimed = hnd().claimed;
    var wasIds = (hnd().ids || []).slice();
    await waitFor(function () { return !!q('#bgPanel'); }, 8000);
    await new Promise(function (r) { setTimeout(r, 3000); });
    add(refuse[c] + '：不认领这张交接单（claimed 原样，不写自己的身份）', hnd().claimed === wasClaimed, JSON.stringify(hnd()).slice(0, 110));
    add(refuse[c] + '：一条大模型请求都不发（不在自己这页跑别人那一轮）', genReqs().length === 0, '发了 ' + genReqs().length + ' 条');
    add(refuse[c] + '：不写批量计划，更不往上面盖自己的心跳', !window.__store.bgBatch, JSON.stringify(window.__store.bgBatch || null).slice(0, 110));
    add(refuse[c] + '：交接单上那几条一条都没被生成', wasIds.every(function (x) { return !dr(x).text; }), JSON.stringify(wasIds.map(function (x) { return !!dr(x).text; })));
    add(refuse[c] + '：照常给用户建面板（这一页就是普通的一页）', !!q('#bgPanel'));
    add(refuse[c] + '：标题也没改成生成器（用户不会莫名多出一个「请别关这个标签页」）', !/招呼语生成器/.test(document.title), document.title);
    add('运行期无未捕获错误', window.__errors.length === 0, window.__errors.join(' ;; '));
    return;
  }

  if (c === 'liveother') {
    await new Promise(function (r) { setTimeout(r, 6000); });
    add('已经有一页在跑这一轮（心跳还新鲜）→ 这一页不抢，计划还是那一页的', plan().by === 'other-page-token', JSON.stringify({ by: plan().by, role: plan().role }));
    add('不写 claimed（抢不到的单就不该在上面留自己的名）', !hnd().claimed, JSON.stringify(hnd()).slice(0, 110));
    add('一条大模型请求都没发（两轮并发 = 同一批岗位烧两份钱）', genReqs().length === 0, '发了 ' + genReqs().length + ' 条');
    add('日志把「为什么不跑」说清了', /已经有一轮在跑了/.test(exLog()), (exLog().match(/[^\n]*已经有一轮[^\n]*/) || ['无'])[0]);
    var gone0 = await waitFor(function () { return window.__closed >= 1; }, 15000);
    add('既不干活也不建面板的这一页自己收摊（不留一个空标签页占着浏览器）', !!gone0, '自关次数=' + window.__closed);
    add('运行期无未捕获错误', window.__errors.length === 0, window.__errors.join(' ;; '));
    return;
  }

  // —— stop：观众页那两颗按钮在这半边的真效果
  if (c === 'stop') {
    var got2 = await waitFor(function () { return plan().role === 'exec' && hnd().claimed; }, 20000);
    add('先正常接手（下面的暂停/停止都是在它跑的过程中按的）', !!got2, JSON.stringify({ claimed: hnd().claimed, role: plan().role }));
    add('跑着的时候这一页离开会被拦（这一轮确实死在这页上）', guardFired(), 'defaultPrevented=' + guardFired());
    plan().pause = true;                   // 这就是观众页那颗「暂停」干的事：往计划上写一条指令
    var one = await waitFor(function () { return dr('aaa111').text; }, 40000);
    var reqs1 = genReqs().length;
    await new Promise(function (r) { setTimeout(r, 5000); });
    add('暂停真的压在这一页的生成节奏上：手上这条飞完就不往下走（不是只改了改按钮）',
      !!one && !dr('bbb222').text && !dr('ccc333').text,
      JSON.stringify({ 请求: reqs1, 草稿: ['aaa111', 'bbb222', 'ccc333'].map(function (x) { return !!dr(x).text; }) }));
    add('这一页的日志写的是「收到暂停」，不是面板那种「已通知」', /收到暂停/.test(exLog()),
      (exLog().match(/[^\n]*收到暂停[^\n]*/) || ['无'])[0]);
    plan().pause = false;
    var two = await waitFor(function () { return dr('bbb222').text; }, 40000);
    add('按「继续」之后接着往下跑（暂停不是取消这一轮）', !!two, JSON.stringify(!!dr('bbb222').text));
    plan().stop = Date.now();
    var parked = await waitFor(function () { return window.__store.bgBatch && window.__store.bgBatch.by === ''; }, 20000);
    add('「停止」也自己收手，并且当场把计划退成没人认领（不等在飞的那条回包）', !!parked,
      JSON.stringify({ by: plan().by, 草稿: ['aaa111', 'bbb222', 'ccc333'].map(function (x) { return !!dr(x).text; }) }));
    add('停下来的这一轮整条计划还挂着（只是没人认领）→ 面板那边看得见「可续跑 N 条」',
      !!parked && (plan().ids || []).length === 3, '计划里记的条数=' + (plan().ids || []).length);
    add('收尾那行「这一轮还剩 N 条」当场落盘（心跳已经停了，没有下一次顺手刷日志）',
      /这一轮还剩 \d+ 条没跑完/.test(exLog()), (exLog().match(/[^\n]*没跑完[^\n]*/) || ['无'])[0]);
    var gone3 = await waitFor(function () { return window.__closed >= 1; }, 45000);
    add('这一页真的收摊：用完自己关（headless 里计数代替真关），收手之后不再拦离开',
      !!gone3 && !guardFired(), '自关=' + window.__closed + ' 拦=' + guardFired());
    add('运行期无未捕获错误', window.__errors.length === 0, window.__errors.join(' ;; '));
    return;
  }

  // —— ok / navmark：真的接手，并把这一轮跑完
  var got = await waitFor(function () { return plan().role === 'exec' && plan().by && hnd().claimed; }, 20000);
  add('认领的两道闸门都过了：交接单写下认领者，计划归到这一页名下且 role=exec',
    !!got && hnd().claimed === plan().by, JSON.stringify({ claimed: hnd().claimed, by: plan().by, role: plan().role }));
  add('这一页不建面板（用户不会误以为要在这儿点按钮）', !q('#bgPanel'));
  if (c === 'navmark') {
    add('站点把地址上的 #bgExec 洗掉了：靠导航记录里那一跳的同一标记照样认领',
      location.hash.indexOf('bgExec=') < 0 && !!got, 'hash=' + location.hash);
  }
  var beat0 = plan().tick;
  await new Promise(function (r) { setTimeout(r, 4500); });
  add('心跳每 2 秒续一次（别的页面靠它判断「这轮还有人认领」，不能抢）',
    plan().tick > beat0, 'tick ' + beat0 + ' → ' + plan().tick);
  add('计划里公布了「正在被这一页写的那几条」，面板据此画「生成中」',
    (plan().gen || []).length >= 1, JSON.stringify(plan().gen || []));
  add('标题改成「招呼语生成器 · 请别关这个标签页」，用户一眼认得出该留哪一页',
    /招呼语生成器/.test(document.title), document.title);
  add('跑着的这一页离开会被拦一道（这一轮真的死在这页上，该拦）', guardFired(), 'defaultPrevented=' + guardFired());
  add('日志分开存：生成器写 bgLogExec，绝不碰面板那份 bgLogBuf（谁也不把对方 200 行盖掉）',
    /生成器标签页起来了/.test(exLog()) && /本轮 2 个岗位/.test(exLog()) && !window.__store.bgLogBuf,
    exLog().split(String.fromCharCode(10)).slice(0, 2).join(' | '));
  var done = await waitFor(function () { return dr('aaa111').text && dr('bbb222').text; }, 40000);
  add('两条草稿由这一页写进存储，带着它自己算的指纹（面板那边才是「已生成」而不是「已过期」）',
    !!done && !!dr('aaa111').fp && !!dr('bbb222').fp,
    JSON.stringify({ 一条有指纹: !!dr('aaa111').fp, 二条有指纹: !!dr('bbb222').fp }));
  add('大模型请求正好两条，一条不多烧一份钱', genReqs().length === 2, '发了 ' + genReqs().length + ' 条');
  add('半自动下这一页一个字都不发（发送只认用户确认过的那一页）',
    window.__sent.length === 0 && !window.__store['bgSent:aaa111'], JSON.stringify(window.__sent).slice(0, 60));
  add('生成期间这一页没再开任何标签页（生成不需要 DOM，也不该顺手把用户那一页跳走）',
    (window.__opened || []).length === 0, JSON.stringify(window.__opened || []).slice(0, 80));
  var fin = await waitFor(function () { return !window.__store.bgBatch && window.__closed >= 1; }, 20000);
  add('跑完撤掉计划、用完自己关这一页（不留一个空转的标签页）', !!fin,
    JSON.stringify({ 计划键数: Object.keys(plan()).length, 自关: window.__closed }));
  add('收工之后不再拦你离开（拦一次就够，别把护栏变成常驻弹窗）', !guardFired(), 'defaultPrevented=' + guardFired());
  add('运行期无未捕获错误', window.__errors.length === 0, window.__errors.join(' ;; '));
}
function render() {
  var bad = R.filter(function (r) { return !r.pass; }).length;
  document.getElementById('rows').innerHTML = R.map(function (r) {
    return '<tr><td>[' + window.__case + '] ' + r.name + '</td><td class="' + (r.pass ? 'pass">PASS' : 'fail">FAIL') + '</td><td class="extra">' +
      String(r.extra).replace(/&/g, '&amp;').replace(/&lt;/g, '&lt;') + '</td></tr>';
  }).join('');
  document.getElementById('sum').innerHTML = bad ? '<span class="fail">' + bad + ' 项失败</span> / 共 ' + R.length + ' 项' : '<span class="pass">全部 ' + R.length + ' 项通过</span>';
  window.__RESULT = R;
}
(async function () {
  try { await run(); }
  catch (e) { add('测试脚本自身异常', false, e.message + ' @ ' + String(e.stack || '').split('\n')[1]); }
  render();
})();`;

const html6 = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>BOSS 打招呼助手 · 生成器标签页测试</title>
<style>
body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:20px 20px 140px}
#chatBox{position:fixed;left:40%;right:20px;top:120px;background:#f2f6ff;border:1px solid #cfe0ff;padding:8px}
.chat-input{display:block;width:70%;height:60px;border:1px solid #ccc;margin-top:12px}
.pass{color:#1c8a45;font-weight:600}.fail{color:#c8402f;font-weight:600}
.extra{color:#7a8698;font-size:12px;word-break:break-all}
table{border-collapse:collapse;width:100%;position:relative;z-index:2;background:#fff}
th,td{border-bottom:1px solid #eee;padding:5px 8px;text-align:left;vertical-align:top}
#sum{font-size:16px;margin:8px 0;position:relative;z-index:2;background:#fff}
h3{position:relative;z-index:2;background:#fff}
</style></head><body>
<h3>BOSS 打招呼助手 · 脚本自己开的那个「生成器」标签页（?case= 切换情形）</h3>
<div id="sum">运行中…</div>
<table><thead><tr><th style="width:38%">断言</th><th style="width:8%">结果</th><th>实际值</th></tr></thead><tbody id="rows"></tbody></table>
${execFixture}
<script>${stubs}<\/script>
<script>${execSeed}<\/script>
<script>/* ==== .user.js 原文 ==== */
${src}
<\/script>
<script>${execAsserts}<\/script>
</body></html>
`;

fs.writeFileSync(path.join(root, 'test', 'ui-exec.html'), html6);
console.log('生成 test/ui-smoke.html + test/ui-sendtab.html + test/ui-hop.html + test/ui-detail.html + test/ui-listsend.html + test/ui-exec.html（各内嵌 ' + src.split('\n').length + ' 行生产代码）');
