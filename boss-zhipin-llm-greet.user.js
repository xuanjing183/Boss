// ==UserScript==
// @name         BOSS直聘 · 收藏岗位大模型打招呼助手
// @namespace    qoder.boss.greet.assistant
// @version      0.4.1
// @description  读取网页版 BOSS 直聘收藏的岗位，连同本地简历一起交给大模型生成个性化打招呼语，再半自动/自动发送给 HR
// @match        https://www.zhipin.com/*
// @match        https://*.zhipin.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @connect      *
// @require      https://registry.npmmirror.com/pdfjs-dist/3.11.174/files/legacy/build/pdf.min.js
// ==/UserScript==

/* pdf.js 镜像说明：用 npmmirror（阿里）是因为 jsdelivr / unpkg 在大陆经常超时（已在本机验证）。
 * 若这个地址也不通，把上面 @require 和「设置」里的 pdfWorkerSrc 一起换成：
 *   https://cdn.bootcdn.net/ajax/libs/pdf.js/3.11.174/pdf.min.js
 *   https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
 *   https://cdn.staticfile.net/pdf.js/3.11.174/pdf.min.js
 */

/*
 * 安装：Edge/Chrome 装 Tampermonkey -> 新建脚本 -> 粘贴本文件 -> Ctrl+S
 * 注意：IE 无法运行（油猴没有 IE 版本，BOSS 直聘网页版也不支持 IE），必须用 Edge 或 Chrome。
 * 首次使用顺序：1) 设置里填 API  2) 简历里选 PDF 或粘文本  3) 打开「收藏」页点「抓当前页」  4) 抓详情  5) 队列里生成 -> 发送
 */
(function () {
  'use strict';

  // 版本号跟上面 @version 保持一致：面板标题和启动日志都会打出来，
  // 方便确认「油猴里跑的到底是哪一版」（改完脚本忘了替换是最常见的坑）。
  const VER = '0.4.1';

  /* ---------------------------------------------------------------- 配置存储 */

  const K = {
    cfg: 'cfg',
    resume: 'resumeText',
    jobs: 'jobs',
    details: 'details',
    drafts: 'drafts',
    stats: 'stats',
    pending: 'pendingDetails'
  };

  const DEFAULT_SYSTEM_PROMPT = [
    '你是帮求职者写 BOSS 直聘打招呼语的助手。',
    '要求：',
    '1) 第一句直接说明你是谁、能做什么，不要「您好，我对该岗位非常感兴趣」这类空话。',
    '2) 从简历里挑与该岗位 JD 最匹配的 2-3 条经历/技能，用具体名词和技术栈说话，不编造简历里没有的东西。',
    '3) 语气自然、像真人在聊天框里打字，不用 markdown、不用列表符号、不加 emoji 或最多一个。',
    '4) 全文 60-120 字，单段落，末尾提一句可约时间或请求查看简历。',
    '5) 不出现薪资期望、不出现「贵公司」这类书面词，用「你们」或直接点名业务。',
    '只输出打招呼语本身，不要任何解释、引号或前后缀。'
  ].join('\n');

  const DEFAULTS = {
    apiBase: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.8,
    maxTokens: 400,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userPrompt: [
      '【我的简历】',
      '{{RESUME}}',
      '',
      '【目标岗位】',
      '{{JOB}}',
      '',
      '请生成一条发给该岗位 HR 的打招呼语。'
    ].join('\n'),
    resumeChars: 6000,
    delayMin: 9000,
    delayMax: 22000,
    maxPerDay: 20,
    autoSend: false,          // false = 半自动（面板里人工确认）
    autoOpenChat: false,      // true  = 自动点「立即沟通」再发送
    autoCloseDetail: true,    // 抓完详情自动关掉那个后台标签页
    pdfWorkerSrc: 'https://registry.npmmirror.com/pdfjs-dist/3.11.174/files/legacy/build/pdf.worker.min.js',
    pdfTimeoutMs: 25000       // 单种 worker 方案的最长耗时，超时自动换下一条路（避免静默卡死）
  };

  let cfg = load(K.cfg, DEFAULTS);
  cfg = Object.assign({}, DEFAULTS, cfg || {});
  // 迁移：老版本存过 jsdelivr（大陆不通），自动换成 npmmirror
  if (/jsdelivr|unpkg\.com/.test(cfg.pdfWorkerSrc || '')) cfg.pdfWorkerSrc = DEFAULTS.pdfWorkerSrc;

  function load(key, fallback) {
    try {
      const v = GM_getValue(key);
      return v === undefined || v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, val) {
    try { GM_setValue(key, val); } catch (e) { log('存储失败: ' + e.message); }
  }
  function saveCfg() { save(K.cfg, cfg); }

  let jobs = load(K.jobs, []) || [];
  let details = load(K.details, {}) || {};
  let drafts = load(K.drafts, {}) || {};
  let stats = load(K.stats, { day: today(), sent: 0, generated: 0 }) || {};
  let pending = load(K.pending, []) || [];

  function today() { return new Date().toISOString().slice(0, 10); }
  function rollStats() {
    if (stats.day !== today()) { stats = { day: today(), sent: stats.sent, generated: stats.generated }; }
    if (stats.sent === undefined) stats.sent = 0;
    if (stats.generated === undefined) stats.generated = 0;
  }
  rollStats();

  /* ---------------------------------------------------------------- 小工具 */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clamp = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; };
  const uid = () => Math.random().toString(36).slice(2, 8);

  // 日志必须常驻内存：切标签时 #bgLog 文本框会被重建，只往 DOM 里写会丢历史
  const logBuf = [];
  function log(msg) {
    logBuf.push('[' + new Date().toTimeString().slice(0, 8) + '] ' + msg);
    if (logBuf.length > 400) logBuf.shift();
    const box = document.getElementById('bgLog');
    if (box) { box.value = logBuf.join('\n'); box.scrollTop = box.scrollHeight; }
    const foot = document.getElementById('bgFoot');
    if (foot) foot.textContent = logBuf[logBuf.length - 1] || '';
    console.log('[BOSS打招呼] ' + msg);
  }

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 4 || r.height <= 4) return false;
    if (el.disabled) return false;
    if (el.offsetParent !== null) return true;
    // offsetParent 为 null 不等于隐藏：position:fixed 的元素天生就是 null，
    // 而沟通页的输入框/发送按钮正好落在固定底栏里，不能一棍子打死。
    try {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
    } catch (e) {
      return false;
    }
  }

  // 关键：面板里也有「发送」按钮和输入框，必须把自己排除掉，否则会点到自己的 UI
  function notMine(el) {
    return !(el.closest && el.closest('#bgPanel, #bgMin'));
  }

  /* ------------------------------------------------- 跨域请求（绕过 CORS/CSP） */

  function gmXhr(method, url, headers, body, timeout) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: method,
        url: url,
        headers: headers || {},
        data: body,
        timeout: timeout || 120000,
        onload: (res) => resolve(res),
        onerror: (e) => reject(new Error('网络错误 ' + url)),
        ontimeout: () => reject(new Error('超时 ' + url)),
        onabort: () => reject(new Error('已取消'))
      });
    });
  }

  const gmText = (url) => gmXhr('GET', url, {}, null, 60000).then((r) => r.responseText);

  /* ---------------------------------------------------------------- 简历 */

  async function resumeFromFile(file) {
    const name = (file.name || '').toLowerCase();
    log('已选择文件：' + file.name + '（' + Math.round(file.size / 1024) + ' KB）');
    try { GM_setValue('resumeSrc', file.name); } catch (e) { /* 忽略 */ }
    updateResumeMeta();

    if (/\.(txt|md|text)$/.test(name)) {
      const text = await file.text();
      setResume(text, file.name);
      return;
    }
    if (!/\.pdf$/.test(name)) { log('✗ 只支持 .pdf / .txt / .md'); return; }
    if (typeof pdfjsLib === 'undefined') {
      log('✗ pdf.js 没加载成功：@require 的资源油猴没下载下来。把下面地址粘到浏览器新标签打开验证是否可达：');
      log('    https://registry.npmmirror.com/pdfjs-dist/3.11.174/files/legacy/build/pdf.min.js');
      log('    能下载 = 脚本里 @require 那行没更新，重新粘贴保存脚本即可；不通 = 换文件头注释里列的 bootcdn/cdnjs 镜像。');
      log('    想立刻继续：简历另存为 .txt 再选一次，或直接粘贴到下面文本框点「保存文本」。');
      return;
    }
    log('开始解析 PDF，v' + (pdfjsLib.version || '?') + '，worker=' + cfg.pdfWorkerSrc.slice(0, 42) + '…');
    const buf = new Uint8Array(await file.arrayBuffer());
    const text = await pdfToText(buf);
    const n = (text || '').trim().length;
    if (n < 40) {
      log('✗ 只抽出 ' + n + ' 字，多半是扫描件（图片型 PDF）。请导出文字版 PDF，或另存为 .txt / 直接粘贴文本。');
      return;
    }
    setResume(text, file.name);
  }

  /* PDF-BEGIN —— 这段会被 test/build-pdf.js 抽出去，用真实生成的中文 PDF 做解析测试
   *
   * pdf.js 有三个坑，决定了下面这段的顺序：
   *   1) 它把「fake worker 建立失败」的 Promise 用 shadow 缓存在 PDFWorker 类上，并把
   *      PDFWorkerUtil.isWorkerDisabled 永久置为 true。所以一旦先让 getDocument 失败一次，
   *      之后再把 worker 补上去也不会被重新读取 —— 必须「先把 worker 备好，再第一次调用」。
   *      而且这两道闩锁在 3.11.174 里都够不着：PDFWorkerUtil 没挂到 UMD 根对象上
   *      （实测 pdfjsLib.PDFWorkerUtil === undefined），_setupFakeWorkerGlobal 是「静态
   *      getter 被 shadow 的数据属性覆盖」的写法，delete 之后 getter 也回不来。
   *      结论：真正跑起来的第一条路线失败后，后面几条基本只会复用同一个错误 ——
   *      所以最稳的主线程路线必须排第一，别指望后面能翻盘。
   *   2) 站点 CSP 一般同时拦住 worker-src（跨源 / blob）和 script-src（远程 worker.js），
   *      所以三条路都要留着，且每条都要有超时，否则会静默挂住再也不返回。
   *   3) 走 GlobalWorkerOptions.workerPort 时，pdf.js 的 _initializeFromPort 直接 resolve，
   *      既不发 "test" 探活也不等 "ready"（实测 ready 是最后才飘回来的），握手是残缺的；
   *      走 workerSrc 时它自己 new Worker、同步挂监听、test/ready 双向握手齐全。
   *      所以要兜底就兜 workerSrc，别兜 workerPort。
   */
  let pdfWorkerText = null;   // worker 源码文本，只拉一次
  let pdfBlobUrl = null;      // 同源 blob 地址，用完要 revoke

  function pdfErr(e) { return String((e && e.message) || e || 'unknown'); }

  async function pdfFetchWorkerText() {
    if (pdfWorkerText && pdfWorkerText.length > 10000) return pdfWorkerText;
    try {
      const src = await gmText(cfg.pdfWorkerSrc);
      if (src && src.length > 10000) {
        pdfWorkerText = src;
        log('PDF worker 源码已取回 ' + Math.round(src.length / 1024) + ' KB');
      } else {
        log('PDF worker 源码异常（' + (src || '').length + ' 字节），多半是镜像地址错了');
      }
    } catch (e) {
      log('PDF worker 源码拉取失败：' + pdfErr(e).slice(0, 120));
    }
    return pdfWorkerText;
  }

  // 路线 1（最稳）：主线程 fake worker。把 worker 源码在本脚本沙箱里执行，pdf.js 看见
  // globalThis.pdfjsWorker 就直接在主线程跑解析，完全不碰站点的 worker-src / script-src。
  function pdfUseMainThread() {
    if (!pdfWorkerText) return false;
    try {
      // eslint-disable-next-line no-new-func
      new Function(pdfWorkerText)();
      const h = globalThis.pdfjsWorker || (typeof window !== 'undefined' && window.pdfjsWorker);
      if (h && h.WorkerMessageHandler) {
        globalThis.pdfjsWorker = h;
        pdfjsLib.GlobalWorkerOptions.workerPort = null;
        log('PDF worker：主线程 fake worker');
        return true;
      }
      log('PDF worker 源码执行完没拿到 WorkerMessageHandler');
    } catch (e) {
      log('路线 1 不可用（' + (e.name || 'Error') + '：沙箱里 eval 被拦）');
    }
    return false;
  }

  // 路线 2：同源 blob 当 workerSrc。源码已经用 GM_xmlhttpRequest 拿回来了（不受 CORS 限制），
  // 打成 blob 之后 pdf.js 认为它同源，会直接 new Worker(blobUrl)，不需要 eval，
  // 也不需要站点 script-src 放行镜像域名，只要 worker-src 放行 blob:（或者站点压根没发 CSP）。
  function pdfUseBlobSrc() {
    if (!pdfWorkerText) return false;
    try {
      pdfRevokeBlob();
      pdfBlobUrl = URL.createObjectURL(new Blob([pdfWorkerText], { type: 'text/javascript' }));
      pdfjsLib.GlobalWorkerOptions.workerPort = null;
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfBlobUrl;
      log('PDF worker：同源 blob（不碰站点 script-src）');
      return true;
    } catch (e) {
      log('路线 2 不可用（' + (e.name || 'Error') + '：造 blob 失败）');
    }
    return false;
  }

  // 路线 3：什么也不搭，让 pdf.js 自己按镜像地址起 worker。跨源时它会包一层
  // importScripts("镜像地址") 的 blob，所以要站点 script-src 明确放行镜像域名，
  // 被拦时它几毫秒就报错（不是挂住），所以放最后、给短超时。
  function pdfUseRemoteWorker() {
    pdfResetWorker();
    pdfjsLib.GlobalWorkerOptions.workerSrc = cfg.pdfWorkerSrc;
    log('PDF worker：站点远程 worker（' + String(cfg.pdfWorkerSrc).replace(/^https?:\/\//, '').slice(0, 40) + '）');
    return true;
  }

  function pdfRevokeBlob() {
    if (!pdfBlobUrl) return;
    try { URL.revokeObjectURL(pdfBlobUrl); } catch (e) { /* 忽略 */ }
    pdfBlobUrl = null;
  }

  function pdfResetWorker() {
    try { pdfjsLib.GlobalWorkerOptions.workerPort = null; } catch (e) { /* 忽略 */ }
    try { delete globalThis.pdfjsWorker; } catch (e) { globalThis.pdfjsWorker = undefined; }
    if (typeof window !== 'undefined') { try { delete window.pdfjsWorker; } catch (e) { /* 忽略 */ } }
    pdfRevokeBlob();
  }

  function pdfWithTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error(label + '超时 ' + Math.round(ms / 1000) + ' 秒（worker 没响应）')), ms);
      })
    ]);
  }

  async function pdfToText(buf) {
    if (typeof pdfjsLib === 'undefined') throw new Error('pdf.js 没有加载成功');
    pdfResetWorker();      // 上一次导入失败留下的闩锁/残骸先清掉，重试才是干净的
    pdfjsLib.GlobalWorkerOptions.workerSrc = cfg.pdfWorkerSrc;
    await pdfFetchWorkerText();

    const limit = Math.max(5000, Number(cfg.pdfTimeoutMs) || 25000);
    // 顺序按「成功概率 × 失败代价」排：
    //   1. 主线程 fake worker —— 只要沙箱允许 eval 就必成（实测 5ms 抽完 458 字），不碰站点 CSP；
    //   2. 同源 blob workerSrc —— 禁 eval 时的主力兜底，握手完整；
    //   3. 远程 workerSrc —— 要站点放行镜像域名，失败得很快，所以超时给短一点。
    const routes = [
      { name: '主线程 fake worker', setup: pdfUseMainThread, needText: true, ms: limit },
      { name: '同源 blob worker', setup: pdfUseBlobSrc, needText: true, ms: Math.min(limit, 12000) },
      { name: '远程 worker', setup: pdfUseRemoteWorker, needText: false, ms: Math.min(limit, 8000) }
    ];
    let lastErr = null;
    const tried = [];

    for (const route of routes) {
      if (route.needText && !pdfWorkerText) continue;   // 没拿到源码就跳过依赖它的路线
      if (!route.setup()) continue;
      tried.push(route.name);
      try {
        const text = await pdfWithTimeout(runParse(buf), route.ms, 'PDF 解析');
        if (!text || !text.trim()) {
          lastErr = new Error('抽出 0 字');
          log('PDF 路线「' + route.name + '」通了但抽出 0 字，换下一条');
        } else {
          log('PDF 解析成功：路线「' + route.name + '」，' + text.length + ' 字');
          return text;
        }
      } catch (e) {
        lastErr = e;
        log('PDF 路线「' + route.name + '」失败：' + pdfErr(e).slice(0, 150));
      }
      pdfResetWorker();
    }
    throw new Error('PDF 没解析出来（试过 ' + (tried.join(' → ') || '0 条路线') + '；'
      + pdfErr(lastErr).slice(0, 100) + '）。把简历另存为 .txt 再选一次，或直接用文本框粘贴，一样能用。');
  }

  async function runParse(buf) {
    const doc = await pdfjsLib.getDocument({
      data: buf.slice(0),            // 每次给一份新副本：pdf.js 可能把 buffer 转移走（detached）
      disableFontFace: true, isEvalSupported: false, verbosity: 0
    }).promise;
    const out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let line = '', lastY = null;
      for (const it of tc.items) {
        if (!it.str) continue;
        const y = it.transform ? it.transform[5] : 0;
        if (lastY !== null && Math.abs(y - lastY) > 3.5) { out.push(line.trim()); line = ''; }
        line += (line && !/\s$/.test(line) && /^[^\s，。、；]/.test(it.str) ? ' ' : '') + it.str;
        lastY = y;
      }
      if (line.trim()) out.push(line.trim());
      out.push('');
    }
    try { await doc.destroy(); } catch (e) { /* 忽略 */ }
    return out.join('\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
  /* PDF-END */

  function selfCheckPdf() {
    if (typeof pdfjsLib === 'undefined') {
      log('✗ pdf.js 未加载（@require 被扩展或网络拦了）→ 请用 .txt 或粘贴文本');
      return;
    }
    log('pdf.js 已加载 v' + (pdfjsLib.version || '?'));
    log('解析时会按「主线程 fake worker → 同源 blob worker → 远程 worker」依次尝试，每条都会打日志');
    // 三条路线各自的先决条件，自检时就告诉你哪条能走，省得到导入时才发现
    try {
      // eslint-disable-next-line no-new-func
      new Function('1');
      log('✓ 沙箱允许 eval → 主线程解析可用（最快，实测几百字只要几毫秒）');
    } catch (e) {
      log('· 沙箱禁 eval（' + (e.name || 'Error') + '）→ 会退到 blob / 远程 worker');
    }
    try {
      const u = URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }));
      const w = new Worker(u);
      w.terminate();
      URL.revokeObjectURL(u);
      log('✓ 该站点允许 blob worker → 就算禁 eval 也能解析');
    } catch (e) {
      log('· 站点 CSP 拦住了 blob worker（' + (e.name || 'Error') + '）→ 只剩远程 worker，'
        + '成功率不高，建议直接把简历另存为 .txt 或粘进文本框');
    }
  }


  function setResume(text, label) {
    const clean = String(text || '').replace(/\r/g, '').trim();
    save(K.resume, clean);
    log('简历已保存：' + clean.length + ' 字' + (label ? '（' + label + '）' : ''));
    const ta = $('#bgBody #bgResume');
    if (ta) ta.value = clean;
    updateResumeMeta();
  }
  function getResume() { return String(load(K.resume, '') || '').trim(); }
  function updateResumeMeta() {
    const el = $('#bgResumeMeta');
    if (!el) return;
    const n = getResume().length;
    let src = '';
    try { src = GM_getValue('resumeSrc', '') || ''; } catch (e) { /* 忽略 */ }
    el.textContent = n ? '已缓存 ' + n + ' 字' + (src ? ' · 来源 ' + src : '')
      : (src ? '上次选了「' + src + '」但没抽出文本，见日志页' : '未设置');
  }

  /* -------------------------------------------------------- 岗位抓取（DOM） */
  /* SCRAPER-BEGIN —— 这段用纯 DOM 启发式，test/scraper-test.html 会抽取本段做回归测试 */

  function jobIdFromHref(href) {
    const m = String(href || '').match(/(?:job_detail\/|[?&]id=)([A-Za-z0-9_%.-]+)/);
    return m ? m[1].replace(/\.html?$/i, '') : '';
  }

  // 找「一张卡片」的最小容器：往上走，但一旦包含第二张岗位卡或文本超限就回退，
  // 避免把整个列表当成一条岗位。
  function findCard(a) {
    let cur = a, prev = a;
    for (let i = 0; i < 8 && cur.parentElement; i++) {
      cur = cur.parentElement;
      const links = $$('a[href*="job_detail"], a[href*="/job/"]', cur).length;
      const txt = cur.innerText || '';
      if (links > 1 || txt.length > 460) return prev;
      prev = cur;
      if (txt.length > 110 && /\d\s*[-~—]\s*\d/.test(txt)) return cur;
    }
    return prev;
  }

  const SALARY_RE = /(\d+(?:\.\d+)?)\s*[-~—]\s*(\d+(?:\.\d+)?)(\s*[Kk千万]|\/\s*月)?(\s*[·]?\s*\d+\s*个月?)?/;
  const CITY_RE = /[一-龥]{2,8}\s*[-·]\s*[一-龥]{2,8}/;

  function pickCompany(lines, title) {
    const cand = lines.filter((s) => s !== title && s.length <= 30 && !/^\d/.test(s) &&
      /(公司|集团|有限|股份|银行|研究院|科技|网络|信息)/.test(s));
    return cand.find((s) => /(公司|有限|集团|银行)$/.test(s)) || cand[0] || '';
  }

  // 标签不从 innerText 的行里取：同一行的多个 span 会被合并成一坨（如 JavaSpring五险一金）
  function pickTags(card, title, company, salary) {
    const out = [];
    $$('span, li, em, i, div', card).forEach((e) => {
      if (e.children.length) return;
      const t = (e.innerText || '').trim();
      if (!t || t.length > 14) return;
      if (t === title || t === company || t === salary) return;
      if (/^\d|^\s*[-~—·]/.test(t)) return;
      if (CITY_RE.test(t)) return;
      if (out.indexOf(t) < 0) out.push(t);
    });
    return out.slice(0, 10);
  }

  // 收藏/感兴趣列表的标题常写成「28届后端实习-番茄红果 [ 上海·杨浦区·五角场 ]」。括号那截是地点：
  // 混进标题既污染给大模型的提示词，又会让沟通页的职位名比对失败（沟通页只渲染纯标题），
  // 实测用户日志里那句「沟通页认不出当前会话是这个岗位」就是这么来的。
  const LOC_TAIL = /\s*[[（(【]\s*([^()（）[\]【】]{2,40}?)\s*[\]）)】]\s*$/;
  function splitTitleLoc(t) {
    const s = String(t || '').trim();
    const m = s.match(LOC_TAIL);
    if (!m) return { title: s, loc: '' };
    const inner = m[1];
    // 方括号是 BOSS 放地点的写法（[ 上海·杨浦区 ]），圆括号多半是限定语（（实习）），
    // 所以只有圆括号那种要看到「市/区/·」才认，方括号短中文也认。
    const square = /[\[【]/.test(m[0]);
    const looksLoc = /[·\-—]/.test(inner) || /(市|区|县|州|镇|街道)/.test(inner) ||
      (square && /^[一-龥]{2,8}$/.test(inner));
    if (!looksLoc) return { title: s, loc: '' };
    return { title: s.replace(LOC_TAIL, '').replace(/\s{2,}/g, ' ').trim(), loc: inner.replace(/\s+/g, '') };
  }

  function parseJobCard(a) {
    const card = findCard(a);
    const raw = (card.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const st = splitTitleLoc((a.innerText || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim() || raw[0] || '');
    const title = st.title;
    const joined = raw.join(' | ');
    const salary = (joined.match(SALARY_RE) || [])[0] || '';
    const compA = $$('a', card).find((x) => /company|gongsi/i.test(x.href || '') && x.innerText.trim().length > 1);
    const company = compA ? compA.innerText.replace(/\s+/g, ' ').trim() : pickCompany(raw, title);
    // 标题尾巴上明确写着地点时优先信它：正文里的「市/区·短语」启发式很容易先咬到
    // 「实习-番茄红果」这种假城市（两段汉字中间一个连字符就算命中了）
    const city = st.loc || (joined.match(CITY_RE) || [])[0] || '';
    const tags = pickTags(card, title, company, salary);
    return {
      id: jobIdFromHref(a.href) || (title + '|' + company),
      title: title,
      company: company,
      salary: salary,
      city: city,
      tags: tags,
      url: a.href.split('?')[0],
      text: raw.join('\n'),
      ts: Date.now()
    };
  }

  function scrapeCurrentPage(silent) {
    const seen = {};
    const found = [];
    $$('a').filter(notMine).forEach((a) => {
      const href = a.href || '';
      if (!/job_detail|jobDetail|\/job\//.test(href)) return;
      const id = jobIdFromHref(href);
      if (!id || seen[id]) return;
      // display:none 的模板/广告节点 innerText 会退回 textContent，必须显式判可见
      if (!visible(a)) return;
      const t = (a.innerText || '').trim();
      if (t.length < 2 || t.length > 80) return;
      seen[id] = 1;
      try { found.push(parseJobCard(a)); } catch (e) { /* 跳过脏节点 */ }
    });
    let added = 0;
    found.forEach((j) => {
      const exist = jobs.findIndex((x) => x.id === j.id);
      if (exist >= 0) { jobs[exist] = Object.assign(jobs[exist], j); }   // 保留已有的 sel，别把用户的取消勾选冲掉
      else { j.sel = true; jobs.push(j); added++; }                      // 新岗位默认进队列
    });
    save(K.jobs, jobs);
    pruneDrafts();
    if (!silent) log('本页识别到 ' + found.length + ' 个岗位，新增 ' + added + ' 个（累计 ' + jobs.length + '）');
    renderJobs();
    return added;
  }

  async function scrapeWithPagination(maxPages) {
    log('开始翻页抓取，最多 ' + maxPages + ' 页');
    let lastCount = -1;
    for (let p = 0; p < maxPages; p++) {
      const n = scrapeCurrentPage(true);
      log('第 ' + (p + 1) + ' 页新增 ' + n + ' 个，累计 ' + jobs.length);
      const before = jobs.length;
      const btn = findNextButton();
      if (!btn) { log('没找到下一页按钮，停止翻页'); break; }
      btn.click();
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        await sleep(500);
        if (jobs.length !== before) break;
      }
      if (jobs.length === before) { log('翻页后无新增，停止'); break; }
      await sleep(rnd(1500, 3200));
      if (jobs.length === lastCount) { log('内容未变化，停止'); break; }
      lastCount = jobs.length;
    }
    renderJobs();
  }

  function findNextButton() {
    const byClass = $$('[class*="next"] button, button.next, a.next, .ui-icon-chevronright, [class*="pagination"] [class*="next"]');
    for (const el of byClass) {
      if (visible(el) && !/disabled/i.test(el.className + ' ' + (el.getAttribute('aria-disabled') || ''))) return el;
    }
    const byText = $$('button, a, span, li').filter((e) => visible(e) && /^(下一页|下页|>)$/.test((e.innerText || '').trim()));
    return byText[0] || null;
  }
  /* SCRAPER-END */

  /* -------------------------------------------- 岗位详情：后台标签 + 跨标签回收 */

  function isDetailTab() {
    const cur = location.href.split('?')[0].split('#')[0];
    const hit = pending.find((p) => normalizeUrl(p.url) === cur);
    if (hit) { pending = pending.filter((p) => p !== hit); save(K.pending, pending); }
    return hit;
  }
  function normalizeUrl(u) {
    u = String(u || '').split('#')[0];
    if (u.endsWith('/')) u = u.slice(0, -1);
    return u;
  }

  function scrapeDetail(id) {
    const pick = (sel) => { const e = $(sel); return e ? (e.innerText || '').trim() : ''; };
    const any = (sels) => { for (const s of sels) { const t = pick(s); if (t.length > 12) return t; } return ''; };
    const body = any(['.job-detail', '.job-boss', '.job-primary', '[class*="job-detail"]', '[class*="job-sec"]', '[class*="job-desc"]', 'main', 'article']);
    let text = body || document.body.innerText || '';
    text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (!/\d+\s*[-~]\s*\d+\s*[Kk千万]/.test(text)) {
      const s = (document.body.innerText.match(/[^\n]{0,10}\d+(?:\.\d+)?\s*[-~]\s*\d+(?:\.\d+)?\s*[Kk千万][^\n]{0,10}/) || [])[0];
      if (s) text = s + '\n' + text;
    }
    details[id] = { id: id, text: clamp(text, 5000), title: document.title.replace(/\s*[-|].*$/, ''), ts: Date.now() };
    save(K.details, details);
    return text.length;
  }

  async function fetchDetails(ids) {
    if (!ids.length) { log('队列里没有待抓详情的岗位'); return; }
    log('打开 ' + ids.length + ' 个后台标签抓详情（期间别关这些标签）');
    for (const id of ids) {
      const job = jobs.find((j) => j.id === id);
      if (!job || !/^https?:/.test(job.url || '')) continue;
      if (details[id] && details[id].text) continue;
      pending.push({ url: job.url, id: id, ts: Date.now() });
      save(K.pending, pending);
      GM_openInTab(job.url, { active: false, insert: true, setParent: true });
      await sleep(rnd(2200, 4200));
    }
    // 轮询等待回收
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      await sleep(1200);
      details = load(K.details, {}) || details;
      const done = ids.filter((i) => details[i] && details[i].text).length;
      log('详情回收进度 ' + done + '/' + ids.length);
      if (done >= ids.length) break;
    }
    renderJobs();
    log('详情抓取结束');
  }

  /* ---------------------------------------------------------------- 大模型 */

  async function chat(systemText, userText, attempt) {
    attempt = attempt || 0;
    if (!cfg.apiKey) throw new Error('未填写 API Key');
    const url = String(cfg.apiBase).replace(/\/+$/, '') + '/chat/completions';
    const body = JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'system', content: systemText }, { role: 'user', content: userText }],
      temperature: Number(cfg.temperature),
      max_tokens: Number(cfg.maxTokens),
      stream: false
    });
    let res;
    try {
      res = await gmXhr('POST', url, {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey
      }, body, 120000);
    } catch (e) {
      if (attempt < 2) { await sleep(2500 * (attempt + 1)); return chat(systemText, userText, attempt + 1); }
      throw e;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 3) { const w = 3000 * Math.pow(2, attempt); log('模型限流/异常 ' + res.status + '，' + w / 1000 + 's 后重试'); await sleep(w); return chat(systemText, userText, attempt + 1); }
    }
    let data = null;
    try { data = JSON.parse(res.responseText); } catch (e) { /* 非 JSON */ }
    if (res.status < 200 || res.status >= 300) {
      const hint = data && data.error ? (data.error.message || JSON.stringify(data.error)) : clamp(res.responseText, 200);
      throw new Error('HTTP ' + res.status + ' ' + hint);
    }
    const content = data && data.choices && data.choices[0] &&
      ((data.choices[0].message && data.choices[0].message.content) || data.choices[0].text);
    if (!content) throw new Error('返回里没有文本内容（检查 model 名/接口路径）');
    return String(content).replace(/^["“'']+|["”'']+$/g, '').trim();
  }

  function jobForPrompt(job) {
    const d = details[job.id];
    const parts = [
      '岗位名称：' + (job.title || d && d.title || ''),
      '公司：' + (job.company || ''),
      '薪资：' + (job.salary || ''),
      '地点：' + (job.city || ''),
      '标签：' + (job.tags || []).join('、')
    ];
    if (d && d.text) parts.push('岗位详情：\n' + clamp(d.text, 2200));
    else if (job.text) parts.push('列表信息：\n' + clamp(job.text, 900));
    return parts.filter(Boolean).join('\n');
  }

  async function generateOne(id) {
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error('岗位不存在');
    const resume = getResume();
    if (resume.length < 60) throw new Error('简历内容太少，先去「简历」页设置');
    const userText = cfg.userPrompt
      .replace('{{RESUME}}', clamp(resume, Number(cfg.resumeChars)))
      .replace('{{JOB}}', jobForPrompt(job));
    const txt = await chat(cfg.systemPrompt, userText);
    drafts[id] = { text: txt, ts: Date.now(), sent: false, fp: draftFp(id) };
    save(K.drafts, drafts);
    stats.generated++;
    save(K.stats, stats);
    renderQueue();
    return txt;
  }

  /* ------------------------- 草稿缓存的失效判定 ---------------------------
   * 简历、岗位信息（含后来补抓的详情）、系统提示词、模型、温度 任一变过，
   * 旧草稿就算过期：队列里不再显示「已生成」，也不给发送按钮，批量时自动重新生成。
   * 这样才不会把「按旧简历写的话术」发给新的 HR。
   */
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function draftFp(id) {
    const job = jobs.find((j) => j.id === id) || {};
    const parts = [getResume(), jobForPrompt(job), cfg.model, cfg.systemPrompt, cfg.userPrompt,
      String(cfg.temperature), String(cfg.resumeChars)];
    return hashStr(parts.join('\u0001'));
  }
  function isDraftStale(id) {
    const d = drafts[id];
    if (!d) return false;
    if (!d.fp) return true;              // 老版本存的草稿没有指纹，一律当作过期
    return d.fp !== draftFp(id);
  }

  /* ------------------- 勾选 = 队列（状态跟着岗位一起持久化） -------------------
   * 以前的坑：勾选只存在内存 map 里，而且「全选/取消」按钮只改了 DOM 的 checked，
   * JS 赋值不会触发 change 事件 → 状态没写回 → 队列页照旧显示全部岗位。
   * 现在勾选写进 job.sel 并落油猴存储；取消勾选立刻丢掉那条未发送的草稿。
   */
  function jobTitle(id) { const j = jobs.find((x) => x.id === id); return (j && (j.title || j.company)) || id; }
  function isSelected(id) { const j = jobs.find((x) => x.id === id); return !!j && j.sel !== false; }
  function selected() { return jobs.filter((j) => j.sel !== false); }

  function dropDraft(id, why) {
    const d = drafts[id];
    if (!d) { delete states[id]; return false; }
    if (d.sent) {                     // 已发送的留着当记录，避免重复骚扰同一个 HR
      log('· ' + why + '：「' + jobTitle(id) + '」已发送过，保留记录（不会重发）');
      return false;
    }
    delete drafts[id];
    delete states[id];
    save(K.drafts, drafts);
    log('· ' + why + '：丢掉「' + jobTitle(id) + '」的未发送草稿，重新勾选后会按最新简历/详情重生成');
    return true;
  }

  function setSel(id, on) {
    const j = jobs.find((x) => x.id === id);
    if (!j) return;
    j.sel = !!on;
    save(K.jobs, jobs);
    if (!on) dropDraft(id, '取消勾选');
    updateStat();
    renderQueue();                    // 不在队列页时它自己会 return，不会抢焦点
  }

  function setSelMany(ids, on) {
    let dropped = 0;
    ids.forEach((id) => {
      const j = jobs.find((x) => x.id === id);
      if (!j) return;
      j.sel = !!on;
      if (!on && drafts[id] && !drafts[id].sent) { delete drafts[id]; delete states[id]; dropped++; }
    });
    save(K.jobs, jobs);
    if (dropped) save(K.drafts, drafts);
    log((on ? '已全选 ' : '已取消全部 ') + ids.length + ' 个岗位' + (dropped ? '，连带丢掉 ' + dropped + ' 条未发送草稿' : ''));
    updateStat();
    renderQueue();
  }

  // 岗位列表被清空/重抓后，草稿里那些已经找不到岗位的记录要一起清掉，否则会一直占着存储
  function pruneDrafts() {
    const alive = {};
    jobs.forEach((j) => { alive[j.id] = 1; });
    const gone = Object.keys(drafts).filter((id) => !alive[id]);
    Object.keys(states).forEach((id) => { if (!alive[id]) delete states[id]; });
    if (!gone.length) return 0;
    gone.forEach((id) => delete drafts[id]);
    save(K.drafts, drafts);
    log('清掉 ' + gone.length + ' 条孤儿草稿（对应岗位已不在列表里）');
    return gone.length;
  }

  /* -------------------------------------------------------------- 发送消息 */

  // 真实沟通页的输入框是 <div class="chat-input" contenteditable="true">（已在本机 Edge 的登录态下看过）。
  // 先按这个精确特征找，找不到再退回「页面下半部分最大的可输入控件」那套启发式。
  const CHAT_INPUT_SELS = [
    'div.chat-input[contenteditable="true"]',
    'div.chat-input[contenteditable]',
    '[class*="chat-input"][contenteditable="true"]',
    '[class*="chat-input"][contenteditable]',
    '#chat-input[contenteditable]',
    'textarea[class*="chat-input"]'
  ];

  function findChatInput() {
    for (const sel of CHAT_INPUT_SELS) {
      const el = $$(sel).filter((e) => notMine(e) && visible(e) && !isUploadish(e))[0];
      if (el) return el;
    }
    const cand = $$('textarea, [contenteditable="true"], [contenteditable=""], input[type="text"]')
      .filter(notMine)
      .filter(visible)
      .filter((el) => !isUploadish(el))
      .filter((el) => {
        const ph = (el.placeholder || '') + ' ' + (el.className || '') + ' ' + (el.getAttribute('aria-label') || '');
        return !/搜索|search|手机号|账号|密码|验证/i.test(ph);
      })
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top > window.innerHeight * 0.3 && r.width > 120;
      });
    cand.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return cand[0] || null;
  }

  function fillInput(el, text) {
    if (el.isContentEditable) {
      el.focus();
      // 直接改 textContent 时，contenteditable 的框架绑定常常收不到有效输入（只有我们手发的那一个事件），
      // 发送按钮就会一直停在 disabled 上。execCommand 走真实输入通道，事件是全套的。
      let ok = false;
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        ok = document.execCommand('insertText', false, text);
      } catch (e) { ok = false; }
      if (!ok || !(el.textContent || '').trim()) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      el.focus();
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Shift' }));
  }

  // 上传/表情/图片这类控件绝对不能碰：旧版 clickSend 用 className 里含 send 去猜按钮，
  // 真实页面上很可能命中工具栏的图片按钮（class 里带 send/img），一点就弹出系统的
  // 「选择图片」文件框 —— 用户截图里那个 *.gif;*.jpg;*.png 的打开对话框就是这么来的。
  function isUploadish(el) {
    if (!el || !el.getAttribute) return false;
    const sig = (String(el.className || '') + ' ' + String(el.getAttribute('aria-label') || '') + ' ' +
      String(el.getAttribute('title') || '') + ' ' + String(el.getAttribute('data-title') || '')).toLowerCase();
    if (/upload|image|\bimg\b|photo|picture|\bfile\b|emoji|face|表情|图片|附件|相机|camera/.test(sig)) return true;
    if (el.querySelector && el.querySelector('input[type="file"]')) return true;
    if (el.closest && el.closest('input[type="file"], [class*="upload"], [class*="emoji"], [class*="image-"]')) return true;
    return false;
  }

  // 只认两种发送方式：① 文本精确等于「发送」的真按钮；② 回车（BOSS 输入框自己写着
  // 「按Enter键发送」，是站点文档化的方式）。不再用 className 猜，猜错的代价是误点上传。
  function findSendButton() {
    const cand = $$('button, [role="button"]').filter((e) => visible(e) && notMine(e) && !isUploadish(e))
      .filter((e) => (e.innerText || '').trim() === '发送');
    // 真实页面上那颗是 button.btn-v2.btn-sure-v2.btn-send，优先它；认不出来再退回文本匹配的那个
    return cand.find((e) => /(^|\s)(btn-send|chat-send|send-btn)(\s|$)/.test(String(e.className || ''))) || cand[0] || null;
  }

  async function clickSendButton() {
    // 空输入时那颗按钮带 class="… disabled"（真实页面上就是这么写的，opacity .5）。
    // 填完字等它自己解禁再点；实在等不到也点一下，最终以输入框是否清空为准。
    for (let i = 0; i < 10; i++) {
      const b = findSendButton();
      if (!b) return false;
      if (!/disabled/i.test(String(b.className || '')) && !b.disabled) { b.click(); return true; }
      await sleep(250);
    }
    const b = findSendButton();
    if (!b) return false;
    b.click();
    return true;
  }

  function sendByEnter(inp) {
    inp.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
    inp.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
    return true;
  }

  async function waitCleared(inp, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (!(inp.value || inp.textContent || '').trim()) return true;
      await sleep(250);
    }
    return !(inp.value || inp.textContent || '').trim();
  }

  // 「立即沟通 / 继续沟通」在真实页面上长这样（本机 Edge 登录态下看过）：
  //   <div class="btn btn-startchat-wrap">
  //     <a class="btn btn-startchat" redirect-url="/web/geek/chat?id=…&jobId=…&securityId=…"
  //        data-url="/wapi/zpgeek/friend/add.json?…" data-isfriend="true">继续沟通</a>
  //   </div>
  // 旧版按 $$('a,button,span,div') 的文档顺序取第一个文本匹配的，命中的是外面那层 wrap <div>：
  // div.click() 的事件目标就是 div，冒泡只会往上不会往下，绑在 <a> 上的处理器根本不跑。
  // 于是「点了 15 秒、页面纹丝不动」，最后报一句误导人的「没找到聊天输入框，也没找到立即沟通」。
  function findChatEntry() {
    const want = /^(立即沟通|继续沟通|打招呼|聊一聊)$/;
    let cand = $$('a, button, [role="button"], span, div')
      .filter((e) => visible(e) && notMine(e) && !isUploadish(e))
      .filter((e) => want.test((e.innerText || '').trim()));
    cand = cand.filter((e) => !cand.some((o) => o !== e && e.contains(o)));   // 只留最里层
    if (cand.length) return cand[0];
    // 站点改版兜底：认特征不认文案
    return $$('a.btn-startchat, [class*="startchat"] a, a[redirect-url], [data-isfriend]')
      .filter((e) => visible(e) && notMine(e) && !isUploadish(e))[0] || null;
  }

  // 按钮自带的跳转地址：点不动（或者点了没反应）时用它直接跳，比猜 DOM 可靠
  function chatEntryTarget(el) {
    if (!el || !el.getAttribute) return '';
    let ru = el.getAttribute('redirect-url') || el.getAttribute('redirecturl') || '';
    if (!ru) {
      const inner = $$('a[redirect-url]', el)[0];
      if (inner) ru = inner.getAttribute('redirect-url') || '';
    }
    if (ru) return ru[0] === '/' ? location.origin + ru : ru;
    const a = (el.closest && el.closest('a')) || (el.querySelector && el.querySelector('a'));
    const href = (a && a.href) || '';
    return /^https?:/i.test(href) ? href : '';
  }

  // 「立即沟通/继续沟通」那颗 <a> 上写着 redirect-url="/web/geek/chat?id=…&jobId=…&securityId=…"，
  // 这一串参数就是「我到底点进了哪个会话」。跳过去之后地址栏会被 SPA 洗掉，但这一串得留着当证据。
  function qsParams(u) {
    const out = {};
    const q = String(u || '').split('?')[1] || String(u || '');
    q.split('&').forEach((kv) => {
      const i = kv.indexOf('=');
      if (i > 0 && !out[kv.slice(0, i)]) { try { out[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1)); } catch (e) { out[kv.slice(0, i)] = kv.slice(i + 1); } }
    });
    return out;
  }
  function chatEntryParams(el) {
    if (!el || !el.getAttribute) return null;
    let ru = el.getAttribute('redirect-url') || el.getAttribute('redirecturl') || '';
    if (!ru) {
      const inner = $$('a[redirect-url]', el)[0] || (el.querySelector && el.querySelector('a[redirect-url]'));
      if (inner) ru = inner.getAttribute('redirect-url') || '';
    }
    if (!ru || !/[?&]jobId=/.test(ru)) return null;
    const p = qsParams(ru);
    const pick = {};
    ['id', 'jobId', 'securityId', 'lid'].forEach((k) => { if (p[k]) pick[k] = p[k]; });
    return Object.keys(pick).length ? pick : null;
  }

  // 沟通页把地址栏洗成 /web/geek/chat，但浏览器自己的「导航计时」条目里还留着最初那一跳的完整 URL。
  // 这是本机实测到的：location 上一个参数都没有，performance 那条 name 里 jobId/securityId 全在。
  function navUrlParams() {
    try {
      const list = (performance.getEntriesByType && performance.getEntriesByType('navigation')) || [];
      const raw = list[0] && (list[0].name || (list[0].toJSON && list[0].toJSON().name));
      if (!raw || String(raw).indexOf('?') < 0) return null;
      const p = qsParams(raw);
      return (p.jobId || p.securityId || p.id) ? p : null;
    } catch (e) { return null; }
  }

  // 填 + 点发送 + 确认。成功信号只认「输入框被清空」。
  async function sendIntoChat(inp, text) {
    fillInput(inp, text);
    await sleep(rnd(500, 1100));
    let how = (await clickSendButton()) ? 'button' : null;
    let cleared = how ? await waitCleared(inp, 2500) : false;
    if (!cleared) {
      if (sendByEnter(inp)) {
        cleared = await waitCleared(inp, 2500);
        if (cleared) how = how ? 'button+enter' : 'enter';
      }
    }
    if (!how) return { ok: false, why: '找到了输入框但没找到「发送」按钮，也没能用回车发出去' };
    // 旧版把「页面正文里出现了这段话」也算成功，可输入框里的文字本来就在正文里，
    // 于是没发出去也报发送成功、还把草稿标成已发送。
    return {
      ok: cleared,
      how: how,
      why: cleared ? '' : '点了发送但输入框没清空，消息大概率没发出去，请人工确认（本次不会标记为已发送）'
    };
  }

  // 半自动用这一条：只在「用户当前就站在沟通页」时填并发。
  // 旧版这里还会顺手去点页面上的「立即沟通」，但那是在面板所在的标签页里点 ——
  // 一点就整页跳走，面板连同这次 await 一起没了；更糟的是收藏列表页上每张卡片都可能
  // 有一颗「立即沟通」，点错卡片就把 A 岗位的话发给了 B 的 HR。所以这里只认输入框。
  async function sendMessage(text) {
    const inp = findChatInput();
    if (!inp) return { ok: false, noComposer: true, why: '这一页没有聊天输入框（不在沟通页）' };
    return await sendIntoChat(inp, text);
  }

  /* ---------------------------------------------------------------- 批处理 */

  const runner = { running: false, paused: false };

  async function runBatch(ids) {
    if (runner.running) { log('批量任务已在运行'); return; }
    runner.running = true; runner.paused = false;
    updateRunnerUI();
    let targets = ids.slice();
    // 已经发过的岗位，半自动/全自动都跳过：不要重复打扰同一个 HR，也别把「已发送」标记冲掉
    const sentIds = targets.filter((id) => drafts[id] && drafts[id].sent);
    targets = targets.filter((id) => !(drafts[id] && drafts[id].sent));
    if (sentIds.length) log('· 跳过 ' + sentIds.length + ' 个已发送过的岗位');
    if (cfg.autoSend) {
      const room = Math.max(0, Number(cfg.maxPerDay) - stats.sent);
      if (room <= 0) { log('已达今日发送上限 ' + cfg.maxPerDay + '，停止'); runner.running = false; updateRunnerUI(); return; }
      if (targets.length > room) { log('受今日上限限制，本轮只处理前 ' + room + ' 个'); targets = targets.slice(0, room); }
    }
    for (const id of targets) {
      if (!runner.running) break;
      while (runner.paused) { await sleep(600); if (!runner.running) break; }
      if (!runner.running) break;
      // 每轮都重新看一眼最新勾选：跑的过程中被取消勾选的岗位，直接跳过，不再发送
      if (!isSelected(id)) {
        log('· 已取消勾选，跳过「' + jobTitle(id) + '」');
        delete states[id];
        continue;
      }
      setJobState(id, '生成中');
      try {
        let draft = drafts[id] && drafts[id].text;
        if (!draft || isDraftStale(id)) {
          if (draft) log('· 「' + jobTitle(id) + '」的草稿已过期（简历/岗位/提示词变过），重新生成');
          draft = await generateOne(id);
        }
        if (!cfg.autoSend) {
          setJobState(id, '待确认');
          log('已生成草稿，去「队列」页确认后点发送 → ' + jobTitle(id));
          continue;
        }
        const room2 = Number(cfg.maxPerDay) - stats.sent;
        if (room2 <= 0) { log('触达今日发送上限，停止'); break; }
        setJobState(id, '发送中');
        const job = jobs.find((j) => j.id === id) || {};
        if (!/^https?:/.test(job.url || '')) throw new Error('没有岗位链接，无法跳转沟通');
        const r = await sendInJobTab(job, draft);
        if (r.ok) {
          drafts[id].sent = true; drafts[id].sentAt = Date.now();
          stats.sent++; save(K.drafts, drafts); save(K.stats, stats);
          setJobState(id, '已发送');
          log('✓ 已发送（' + (cfg.autoSend ? '全自动' : '半自动') +
            (r.how ? '，' + String(r.how).replace('button', '点按钮').replace('enter', '回车') : '') +
            '）：' + job.title + ' / ' + job.company);
        } else {
          setJobState(id, '发送失败');
          log('✗ ' + job.title + ' 发送失败：' + r.why);
        }
        updateRunnerUI();
      } catch (e) {
        setJobState(id, '出错');
        log('✗ ' + id + ' 失败：' + e.message);
      }
      await sleep(rnd(cfg.delayMin, cfg.delayMax));
    }
    runner.running = false; updateRunnerUI(); renderQueue();
    log('批量任务结束（今日已发 ' + stats.sent + '/' + cfg.maxPerDay + '）');
  }

  // 自动模式：开一个岗位页标签，让它跑「点沟通入口 -> 跳到沟通页 -> 填 -> 发」。
  // 关键：点「继续沟通」大概率是整页跳转，跳过去之后原来那个 JS 上下文连同这里的 await
  // 一起被销毁，回执只能由跳转后的沟通页写（见 writeHop / runHopSend）。
  // fillOnly=true 时走到沟通页只把话填好、不点发送（半自动走这条）。
  async function sendInJobTab(job, text, fillOnly) {
    GM_setValue('sendReq', {
      url: job.url, text: text, id: job.id, ts: Date.now(),
      title: job.title || '', company: job.company || '', fillOnly: !!fillOnly
    });
    GM_openInTab(job.url, { active: true, insert: true, setParent: true });
    const k = key0(job.id);
    const t0 = Date.now();
    let out = null;
    while (Date.now() - t0 < 60000) {
      await sleep(600);
      const res = GM_getValue('sendRes', null) || {};
      if (res[k] && (res[k].url === job.url || res[k].jobId === job.id)) {
        out = res[k]; delete res[k]; GM_setValue('sendRes', res); break;
      }
      // 岗位页点了沟通按钮之后就会跳走，本页的 sendReq 匹配不上了。这时把 sendReq 撤掉，
      // 免得用户之后自己点开同一个岗位页，脚本不打招呼又自动发一条。
      const pend = GM_getValue('sendReq', null);
      if (pend && pend.id === job.id && Date.now() - pend.ts > 12000) GM_setValue('sendReq', null);
    }
    const pend2 = GM_getValue('sendReq', null);
    if (pend2 && pend2.id === job.id) GM_setValue('sendReq', null);
    const hop = GM_getValue('sendHop', null);
    if (hop && hop.jobId === job.id) GM_setValue('sendHop', null);   // 同理：地雷不能留
    if (!out) {
      return {
        ok: false,
        why: '后台标签 60s 内没回执（多半是没找到沟通入口、被登录态/验证码拦了，或站点结构变了）。' +
          '本次不标记为已发送；请自己去那个岗位页看一眼，若消息其实发出去了，别再点发送'
      };
    }
    if (!out.ok && !out.why) out.why = '后台标签报告发送未确认（点了发送但输入框没清空）';
    return out;
  }
  function key0(id) { return String(id).slice(0, 24); }

  /* -------------------------------------------- 跨页「发送接力」（点沟通会整页跳转） */

  // sessionStorage 是这里最合适的载体：同一个标签页导航之后还在，别的标签页看不见。
  // 所以「这个沟通页是不是我刚点进来的那个岗位」能被可靠地回答，用户自己随手开一个
  // 沟通页时不会莫名其妙发出一条消息。GM 存储那份只是兜底（站点改成开新标签时接得住）。
  const HOP_SS = 'bgGreetHop';
  const HOP_TTL = 60000;

  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }

  function writeHop(h) {
    h.ts = Date.now();
    ssSet(HOP_SS, JSON.stringify(h));
    try { GM_setValue('sendHop', h); } catch (e) {}
    return h;
  }
  function clearHop() {
    ssDel(HOP_SS);
    try { GM_setValue('sendHop', null); } catch (e) {}
  }
  function readHop() {
    let h = null;
    try { h = JSON.parse(ssGet(HOP_SS) || 'null'); } catch (e) { h = null; }
    let fromSS = !!h;
    if (!h) { try { h = GM_getValue('sendHop', null); } catch (e) { h = null; } }
    if (!h || typeof h !== 'object' || !h.jobId || !h.text) return null;
    if (Date.now() - (h.ts || 0) > HOP_TTL) { clearHop(); return null; }
    h._fromSS = fromSS;
    return h;
  }

  function looksLikeChat() {
    return /\/web\/geek\/chat|\/chat\b|\/greet|\/boss\/chat/i.test(location.pathname + location.search) || !!findChatInput();
  }

  // 沟通页加载完会把 URL 上的 ?id=&jobId= 全洗掉（本机实测：跳到 /web/geek/chat，参数一个不剩），
  // 所以「当前会话到底是不是这个岗位」不能看地址栏。两条证据，一条比一条软：
  //   ① 浏览器导航计时里那条原始 URL（SPA 洗不掉）；
  //   ② 右侧当前会话的职位卡（实测是 <span class="position-name">28届后端实习-番茄红果</span>）。
  // 注意：真实沟通页上**没有任何** job_detail 链接（「查看职位」是个不带 href 的 div，
  // 点了才由 JS 开新标签），所以旧版按 `a[href*="job_detail"]` 找证据的写法在真站点上永远命中不了。
  function normTitle(s) {
    return String(s || '')
      .replace(/[[(（【{][^\])）】}]*[\])）】}]/g, ' ')
      .replace(/[\s　·•|,，.。、\-—_~/()]+/g, '')
      .toLowerCase();
  }
  function titleMatch(a, b) {
    if (!a || !b) return false;
    const s = a.length <= b.length ? a : b, l = a.length <= b.length ? b : a;
    return s.length >= 4 && s.length / l.length >= 0.6 && l.indexOf(s) >= 0;
  }
  // BOSS 的 jobId 有时带 ~~ 尾巴，两边长度不一致时按公共前缀比
  function sameJobId(a, b) {
    a = String(a || '').replace(/~+$/, ''); b = String(b || '').replace(/~+$/, '');
    if (!a || !b) return false;
    if (a === b) return true;
    const n = Math.min(a.length, b.length);
    return n >= 14 && a.slice(0, n) === b.slice(0, n);
  }
  function chatJobTitles() {
    const out = [];
    $$('[class*="position-name"], [class*="job-name"], [class*="job-title"], [class*="chat-top"] [class*="name"]').forEach((e) => {
      if (!notMine(e) || !visible(e)) return;
      const r = e.getBoundingClientRect();
      if (r.left < window.innerWidth * 0.28) return;      // 左半边是会话列表，那里出现岗位名不代表当前会话
      const t = (e.innerText || '').trim();
      if (t && t.length <= 60) out.push(t);
    });
    return out;
  }
  // v = 'yes' 能确认 / 'no' 认出来不是这个岗位（绝不能发）/ 'unknown' 这一页没有可比对的东西
  function chatPageVerdict(hop) {
    const np = navUrlParams();
    const c = hop.chat || {};
    if (np && np.jobId && (sameJobId(np.jobId, hop.jobId) || (c.jobId && sameJobId(np.jobId, c.jobId)))) return { v: 'yes', why: '' };
    if (c.securityId && np && np.securityId && c.securityId === np.securityId) return { v: 'yes', why: '' };
    // 这一跳的 URL 带着 jobId 却对不上：多半是会话切走了，别往下猜
    const navSaysNo = !!(np && np.jobId && !sameJobId(np.jobId, hop.jobId) && !(c.jobId && sameJobId(np.jobId, c.jobId)));
    const titles = chatJobTitles();
    if (!titles.length) return navSaysNo ? { v: 'no', why: '这一页打开的会话是另一个岗位' } : { v: 'unknown', why: '' };
    if (navSaysNo) return { v: 'no', why: '这一页打开的会话是另一个岗位' };
    const want = normTitle(hop.title);
    if (want.length >= 4 && titles.some((t) => titleMatch(want, normTitle(t)))) return { v: 'yes', why: '' };
    return { v: 'no', why: '沟通页右侧的职位名是「' + clamp(titles[0], 24) + '」，和这条岗位对不上' };
  }
  function chatPageConfirms(hop) { return chatPageVerdict(hop).v === 'yes'; }

  function hopResult(hop, res) {
    try {
      const all = GM_getValue('sendRes', {}) || {};
      all[key0(hop.jobId)] = {
        url: hop.jobUrl || '', jobId: hop.jobId,
        ok: !!res.ok, why: res.why || '', how: res.how || '', filled: !!res.filled
      };
      GM_setValue('sendRes', all);
    } catch (e) { log('回执写失败：' + e.message); }
    if (res.ok) log('✓ 沟通页已发送（接力）：' + (hop.title || hop.jobId));
    else if (res.filled) log('· 沟通页只填好没发送（半自动），去那个标签页点「发送」：' + (hop.title || hop.jobId));
    else log('✗ 沟通页发送未确认（接力）：' + (hop.title || hop.jobId) + ' —— ' + res.why);
    return res;
  }

  // 接力后半：在跳转后的沟通页里等输入框 + 确认会话身份 + 填 + 发（fillOnly 时只填不发）
  async function runHopSend(hop) {
    clearHop();                       // 先销账：一个接力只执行一次，绝不留下自动发送的地雷
    const t0 = Date.now();
    let inp = null;
    let vd = { v: 'unknown', why: '' };
    while (Date.now() - t0 < 20000) {
      inp = findChatInput();
      if (inp) {
        vd = chatPageVerdict(hop);
        if (vd.v !== 'unknown') break;          // 确认了、或明确不是这个岗位，都停止等待；职位卡还没渲染就继续等
      }
      await sleep(500);
    }
    if (!inp) {
      return hopResult(hop, { ok: false, why: '跳到沟通页后 20s 内没等到聊天输入框（沟通页没加载出来，或站点改版了）' });
    }
    if (vd.v === 'unknown') vd = chatPageVerdict(hop);
    if (vd.v === 'no') {
      return hopResult(hop, {
        ok: false,
        why: '沟通页当前会话不是这条岗位（' + (vd.why || '职位名对不上') + '），为避免发错人已经停手，本次不标记为已发送。' +
          '若确实是这个岗位，请去「队列」页手动点该行发送'
      });
    }
    if (vd.v === 'unknown') {
      // 这一页找不到任何能对照的职位名（站点改版、或职位卡没渲染出来）：不自动发送，
      // 但把话填好 —— 比直接罢工有用，最后那一下由用户自己确认，不会发错人。
      fillInput(inp, hop.text);
      return hopResult(hop, {
        ok: false, filled: true, how: 'filled',
        why: '沟通页拿不到可对照的职位名，为防发错人只填了输入框没发送，请你看一眼再点「发送」'
      });
    }
    if (hop.fillOnly) {
      // 半自动：脚本只负责把话填进输入框，最后那一下由用户自己点「发送」。
      // 这一页绝不能关，也不能标成已发送 —— 用户回来重发一次是允许的，不算骚扰。
      fillInput(inp, hop.text);
      return hopResult(hop, {
        ok: false, filled: true, how: 'filled',
        why: '已在沟通页把招呼语填进输入框，请去那个标签页看一眼后自己点「发送」（没标记为已发送）'
      });
    }
    const res = await sendIntoChat(inp, hop.text);
    if (res.ok) GM_setValue('sendDone:' + hop.jobId + ':hop', true);
    return hopResult(hop, res);
  }

  // 在「被脚本打开的岗位页」里执行发送
  async function maybeHandleSendRequest() {
    const req = GM_getValue('sendReq', null);
    if (!req || !req.url) return;
    if (!sameJobPage(req.url, location.href)) return;
    if (GM_getValue('sendDone:' + req.id + location.href, false)) return;
    await sleep(rnd(1800, 3200));

    let inp = findChatInput();
    if (!inp) {
      if (!(cfg.autoOpenChat || cfg.autoSend)) {
        return reportSend(req, { ok: false, why: '这一页没有聊天输入框，而「自动点击立即沟通」没勾上，脚本就不自己点了（要自动就回「设置」勾上）' });
      }
      const entry = findChatEntry();
      if (!entry) {
        return reportSend(req, { ok: false, why: '岗位页上没找到「立即沟通/继续沟通」按钮（可能站点改版，或这个岗位已经不能沟通）' });
      }
      const label = (entry.innerText || '沟通').trim();
      // 先立接力牌再点：点完很可能整页跳走，本上下文当场就没
      const hop = writeHop({
        jobId: req.id, jobUrl: req.url, title: req.title || '', company: req.company || '',
        text: req.text, from: 'entry', fillOnly: !!req.fillOnly, chat: chatEntryParams(entry)
      });
      entry.click();
      const t0 = Date.now();
      while (Date.now() - t0 < 6000) {
        await sleep(400);
        if (findChatInput()) break;                                   // SPA 没换上下文，就地发
        if (!sameJobPage(req.url, location.href)) break;              // 已经跳去沟通页了（沟通页 URL 不带 jobId）
      }
      inp = findChatInput();
      if (!inp && sameJobPage(req.url, location.href)) {
        // 还停在岗位页且没有输入框：按按钮自带的 redirect-url 自己跳一次，跳过去由沟通页接手
        const tgt = chatEntryTarget(entry);
        if (/^https?:/i.test(tgt)) {
          log('· 点「' + label + '」没出输入框，改用按钮上的 redirect-url 直接跳沟通页');
          writeHop(hop);
          location.href = tgt;
          return;                                        // 本上下文即将销毁，回执由沟通页写
        }
        clearHop();
        return reportSend(req, {
          ok: false,
          why: '点了「' + label + '」但这一页始终没出现聊天输入框，也没拿到沟通页地址（站点结构可能变了）'
        });
      }
      if (!inp) return;                                  // 正在跳转中：交给跳转后的页面，这里别写失败回执
    }
    if (req.fillOnly) {
      fillInput(inp, req.text);
      clearHop();
      return reportSend(req, {
        ok: false, filled: true, how: 'filled',
        why: '已把招呼语填进这一页的输入框，请你自己核对后点「发送」（没标记为已发送）'
      });
    }
    const res = await sendIntoChat(inp, req.text);
    if (res.ok) GM_setValue('sendDone:' + req.id + location.href, true);
    clearHop();
    return reportSend(req, res);
  }

  function reportSend(req, res) {
    try {
      const all = GM_getValue('sendRes', {}) || {};
      all[key0(req.id)] = {
        url: req.url, jobId: req.id, ok: !!res.ok, why: res.why || '', how: res.how || '',
        filled: !!res.filled
      };
      GM_setValue('sendRes', all);
    } catch (e) { log('回执写失败：' + e.message); }
    return res;
  }

  // 岗位页 URL 会被站点改写（加载后自己补 securityId/lid），所以比对 jobId 而不是整串
  function sameJobPage(a, b) {
    const ia = jobIdFromHref(a), ib = jobIdFromHref(b);
    if (ia && ib) return ia === ib;
    return normalizeUrl(a) === normalizeUrl(b);
  }

  /* ------------------------------------------------------------------ UI */

  const STYLE = `
  #bgPanel{position:fixed;right:18px;top:70px;width:430px;max-height:80vh;z-index:2147483646;
    display:flex;flex-direction:column;background:#fff;border:1px solid #d8dee8;border-radius:10px;
    box-shadow:0 8px 30px rgba(0,0,0,.16);font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#222}
  #bgPanel *{box-sizing:border-box;font-family:inherit}
  #bgHead{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#1a6fd8;color:#fff;border-radius:10px 10px 0 0;cursor:move}
  #bgHead b{flex:1;font-size:13px;font-weight:600}
  #bgTabs{display:flex;gap:2px;padding:6px 8px 0;border-bottom:1px solid #eaeef4;background:#f7f9fc}
  #bgTabs button{padding:6px 12px;border:0;border-radius:6px 6px 0 0;background:transparent;cursor:pointer;font-size:12.5px;color:#5a6675}
  #bgTabs button.on{background:#fff;color:#1a6fd8;font-weight:600;box-shadow:0 -1px 0 #1a6fd8 inset}
  #bgBody{padding:10px 12px;overflow:auto;max-height:calc(80vh - 96px)}
  #bgBody fieldset{border:1px solid #e6ebf2;border-radius:8px;margin:0 0 10px;padding:8px 10px}
  #bgBody legend{padding:0 5px;font-size:12px;color:#7a8698}
  #bgBody label{display:block;margin:5px 0 2px;font-size:12px;color:#5a6675}
  #bgBody input,#bgBody textarea,#bgBody select{width:100%;padding:6px 8px;border:1px solid #d8dee8;border-radius:6px;font-size:12.5px;background:#fff}
  #bgBody textarea{resize:vertical}
  #bgBody .row{display:flex;gap:8px;align-items:center}
  #bgBody .row>*{flex:1}
  #bgBody .btns{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
  #bgBody button.act{padding:6px 11px;border:1px solid #cdd6e2;background:#fff;border-radius:6px;cursor:pointer;font-size:12.5px}
  #bgBody button.pri{background:#1a6fd8;border-color:#1a6fd8;color:#fff}
  #bgBody button.warn{background:#e8543f;border-color:#e8543f;color:#fff}
  #bgBody .job{display:flex;gap:7px;padding:7px 6px;border-bottom:1px dashed #eaeef4;align-items:flex-start}
  #bgBody .job .t{flex:1;min-width:0}
  #bgBody .job .t b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #bgBody .job .t i{display:block;font-style:normal;color:#7a8698;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #bgBody .st{font-size:11px;padding:2px 6px;border-radius:9px;background:#eef2f7;color:#5a6675;white-space:nowrap}
  #bgBody .st.sent{background:#e6f6ec;color:#1c8a45}
  #bgBody .st.err{background:#fdeceb;color:#c8402f}
  #bgBody .st.run{background:#e8f1fd;color:#1a6fd8}
  #bgBody .st.stale{background:#fff4e5;color:#b26a00}
  #bgBody .draft{background:#f7f9fc;border:1px solid #e6ebf2;border-radius:6px;padding:6px 8px;margin:4px 0 6px;white-space:pre-wrap;font-size:12.5px}
  #bgBody .draft.stale{opacity:.55;border-style:dashed;border-color:#e8c48a}
  #bgBody .mini{font-size:11px;color:#93a0b1}
  #bgBody .mini.warn{color:#b26a00}
  #bgBody .hint{font-size:11.5px;color:#93a0b1;margin:4px 0 8px}
  #bgBody .danger{color:#c8402f}
  #bgFoot{padding:5px 12px;border-top:1px solid #eaeef4;background:#f7f9fc;color:#5a6675;
    font-size:11.5px;min-height:22px;border-radius:0 0 10px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #bgMin{position:fixed;right:18px;bottom:80px;z-index:2147483646;padding:8px 12px;border:0;border-radius:20px;
    background:#1a6fd8;color:#fff;cursor:pointer;box-shadow:0 4px 14px rgba(26,111,216,.4);font-size:12.5px;display:none}
  `;

  let panel, tabs, bodyEl, curTab = 'cfg';

  function buildPanel() {
    const st = document.createElement('style');
    st.textContent = STYLE;
    document.documentElement.appendChild(st);

    panel = document.createElement('div');
    panel.id = 'bgPanel';
    panel.innerHTML =
      '<div id="bgHead"><b>BOSS 打招呼助手</b>' +
      '<span class="mini" style="color:#9fc0ee;margin-left:6px">v' + VER + '</span>' +
      '<span id="bgStat" class="mini" style="color:#dbe8fb"></span>' +
      '<button id="bgClose" style="border:0;background:transparent;color:#fff;cursor:pointer;font-size:16px">×</button></div>' +
      '<div id="bgTabs">' +
      ['cfg|设置', 'resume|简历', 'jobs|岗位', 'queue|队列', 'log|日志'].map((t) => {
        const p = t.split('|');
        return '<button data-t="' + p[0] + '" class="' + (p[0] === curTab ? 'on' : '') + '">' + p[1] + '</button>';
      }).join('') +
      '</div><div id="bgBody"></div><div id="bgFoot">就绪</div>';
    document.documentElement.appendChild(panel);
    bodyEl = $('#bgBody', panel);
    tabs = $$('#bgTabs button', panel);
    tabs.forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.t)));
    $('#bgClose', panel).addEventListener('click', () => { panel.style.display = 'none'; $('#bgMin').style.display = 'block'; });
    dragHeader($('#bgHead', panel), panel);

    const min = document.createElement('button');
    min.id = 'bgMin';
    min.textContent = '打招呼助手';
    min.addEventListener('click', () => { panel.style.display = 'flex'; min.style.display = 'none'; });
    document.documentElement.appendChild(min);

    render();
  }

  function dragHeader(handle, box) {
    let sx, sy, ox, oy, on = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      on = true; sx = e.clientX; sy = e.clientY;
      const r = box.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!on) return;
      box.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      box.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
      box.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { on = false; });
  }

  function switchTab(t) { curTab = t; tabs.forEach((b) => b.classList.toggle('on', b.dataset.t === t)); render(); }

  function render() {
    updateStat();
    if (curTab === 'cfg') renderCfg();
    else if (curTab === 'resume') renderResume();
    else if (curTab === 'jobs') renderJobsTab();
    else if (curTab === 'queue') renderQueue();
    else renderLog();
  }

  function selCount() { return selected().length; }
  function updateStat() {
    const el = $('#bgStat', panel);
    if (el) el.textContent = '岗位 ' + jobs.length + ' · 选中 ' + selCount() +
      ' · 详情 ' + Object.keys(details).length + ' · 今日 ' + stats.sent + '/' + cfg.maxPerDay;
  }
  function updateRunnerUI() { updateStat(); }

  /* ---- 设置页 ---- */
  function renderCfg() {
    bodyEl.innerHTML =
      '<fieldset><legend>大模型接口（OpenAI 兼容）</legend>' +
      '<label>API Base</label><input id="c_base" value="' + esc(cfg.apiBase) + '" placeholder="https://api.xxx.com/v1">' +
      '<label>API Key（仅存本机油猴存储，不会写进日志）</label>' +
      '<div class="row"><input id="c_key" type="password" value="' + esc(cfg.apiKey) + '" placeholder="sk-...">' +
      '<button class="act" id="c_eye" style="flex:0 0 60px">显示</button></div>' +
      '<label>Model</label><input id="c_model" value="' + esc(cfg.model) + '">' +
      '<div class="row"><div><label>temperature</label><input id="c_temp" value="' + esc(cfg.temperature) + '"></div>' +
      '<div><label>max_tokens</label><input id="c_mt" value="' + esc(cfg.maxTokens) + '"></div></div>' +
      '<div class="btns"><button class="act pri" id="c_save">保存设置</button><button class="act" id="c_test">连通测试</button></div>' +
      '<div class="hint">Key 泄露风险：不要把这个脚本上传到公开仓库；换电脑前手动备份。</div>' +
      '</fieldset>' +

      '<fieldset><legend>发送策略</legend>' +
      '<label class="mini"><input type="radio" name="mode" id="m_semi" ' + (!cfg.autoSend ? 'checked' : '') + ' style="width:auto"> 半自动：脚本只生成，我点「发送」</label>' +
      '<label class="mini"><input type="radio" name="mode" id="m_auto" ' + (cfg.autoSend ? 'checked' : '') + ' style="width:auto"> 全自动：生成后自动开沟通页发送</label>' +
      '<div class="hint danger">全自动批量打招呼违反 BOSS 直聘用户协议，有限流/封号风险；先小量验证，别一上来就跑几十条。</div>' +
      '<div class="row"><div><label>最小间隔(ms)</label><input id="c_dmin" value="' + esc(cfg.delayMin) + '"></div>' +
      '<div><label>最大间隔(ms)</label><input id="c_dmax" value="' + esc(cfg.delayMax) + '"></div>' +
      '<div><label>每日上限</label><input id="c_max" value="' + esc(cfg.maxPerDay) + '"></div></div>' +
      '<label class="mini"><input type="checkbox" id="c_open" ' + (cfg.autoOpenChat ? 'checked' : '') + ' style="width:auto"> 自动点击「立即沟通」（全自动必开；半自动靠它在另开的标签页里走到沟通页。关掉后只有你已经站在沟通页时才会填）</label>' +
      '<div class="hint">全自动的一条发送会自己开一个标签页：岗位页 → 点沟通入口 → 跳到沟通页 → 填 → 点发送。' +
      '跳转后的那一页先确认「当前会话就是这条岗位」：比对浏览器导航记录里那一跳的 jobId（沟通页会把地址栏洗掉，' +
      '但导航记录里还在）和页面右侧的职位名。对不上就停手不发送；实在拿不到可比对的东西就只填不发，' +
      '留给你确认，避免把话发给错的 HR。</div>' +
      '<label class="mini"><input type="checkbox" id="c_close" ' + (cfg.autoCloseDetail ? 'checked' : '') + ' style="width:auto"> 后台标签用完自动关闭（只关发成功的那个；失败的留着给你看）</label>' +
      '<div class="btns"><button class="act" id="c_save2">保存策略</button></div>' +
      '</fieldset>' +

      '<fieldset><legend>提示词（{{RESUME}} / {{JOB}} 会自动替换）</legend>' +
      '<label>System</label><textarea id="c_sys" rows="8">' + esc(cfg.systemPrompt) + '</textarea>' +
      '<label>User</label><textarea id="c_usr" rows="6">' + esc(cfg.userPrompt) + '</textarea>' +
      '<div class="btns"><button class="act" id="c_save3">保存提示词</button><button class="act" id="c_reset">恢复默认提示词</button></div>' +
      '</fieldset>';

    const g = (id) => $('#' + id, bodyEl);
    $('#c_eye', bodyEl).addEventListener('click', () => {
      const i = g('c_key'); const show = i.type === 'password';
      i.type = show ? 'text' : 'password'; $('#c_eye', bodyEl).textContent = show ? '隐藏' : '显示';
    });
    const collect = () => {
      cfg.apiBase = g('c_base').value.trim() || DEFAULTS.apiBase;
      cfg.apiKey = g('c_key').value.trim();
      cfg.model = g('c_model').value.trim();
      cfg.temperature = Number(g('c_temp').value) || 0.8;
      cfg.maxTokens = Number(g('c_mt').value) || 400;
    };
    $('#c_save', bodyEl).addEventListener('click', () => { collect(); saveCfg(); log('设置已保存（Key ' + (cfg.apiKey ? '长度 ' + cfg.apiKey.length : '空') + '）'); });
    $('#c_save2', bodyEl).addEventListener('click', () => {
      collect();
      cfg.autoSend = $('#m_auto', bodyEl).checked;
      cfg.delayMin = Math.max(2000, Number(g('c_dmin').value) || 9000);
      cfg.delayMax = Math.max(cfg.delayMin, Number(g('c_dmax').value) || 22000);
      cfg.maxPerDay = Math.max(1, Number(g('c_max').value) || 20);
      cfg.autoOpenChat = $('#c_open', bodyEl).checked;
      cfg.autoCloseDetail = $('#c_close', bodyEl).checked;
      // 全自动开出来的就是岗位详情页，不点「立即沟通」永远等不到输入框。
      // 与其让用户自己发现每条都失败，不如保存时直接把这项打开并说明原因。
      if (cfg.autoSend && !cfg.autoOpenChat) {
        cfg.autoOpenChat = true;
        log('· 已同时打开「自动点击立即沟通」：全自动必须靠它打开沟通页，否则每条都会失败');
      }
      saveCfg(); log('策略已保存：' + (cfg.autoSend ? '全自动' : '半自动'));
      renderCfg();
    });
    $('#c_save3', bodyEl).addEventListener('click', () => {
      cfg.systemPrompt = g('c_sys').value;
      cfg.userPrompt = g('c_usr').value;
      saveCfg(); log('提示词已保存');
    });
    $('#c_reset', bodyEl).addEventListener('click', () => {
      cfg.systemPrompt = DEFAULT_SYSTEM_PROMPT; cfg.userPrompt = DEFAULTS.userPrompt; saveCfg(); renderCfg(); log('提示词已恢复默认');
    });
    $('#c_test', bodyEl).addEventListener('click', async () => {
      collect(); saveCfg();
      log('测试连通 ' + cfg.apiBase + ' / ' + cfg.model + ' ...');
      try {
        const t = await chat('你是一个只回答测试字样的助手。', '只回复两个字：通了');
        log('✓ 模型返回：' + clamp(t, 40));
      } catch (e) {
        log('✗ 失败：' + e.message);
      }
    });
  }

  /* ---- 简历页 ---- */
  function renderResume() {
    bodyEl.innerHTML =
      '<fieldset><legend>简历来源（三选一，都会缓存到本机）</legend>' +
      '<div class="btns"><input type="file" id="r_file" accept=".pdf,.txt,.md" style="border:0;padding:0">' +
      '<button class="act" id="r_clear">清除缓存</button></div>' +
      '<label>或直接粘贴/编辑文本</label>' +
      '<textarea id="bgResume" rows="16" placeholder="把你的简历正文粘在这里，或选 PDF 自动抽取后编辑">' + esc(getResume()) + '</textarea>' +
      '<div class="row"><div class="mini" id="bgResumeMeta"></div>' +
      '<div><label>喂给模型的最大字数</label><input id="r_chars" value="' + esc(cfg.resumeChars) + '"></div></div>' +
      '<div class="btns"><button class="act pri" id="r_save">保存文本</button><button class="act" id="r_pdfinfo">PDF 解析自检</button></div>' +
      '<div class="hint">浏览器沙箱不能直接读你的磁盘，所以必须手动选一次文件；PDF 走 pdf.js，遇到站点 CSP 拦截会退回文本粘贴。</div>' +
      '</fieldset>';
    updateResumeMeta();
    $('#r_file', bodyEl).addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) { log('文件选择框为空（未选到文件）'); return; }
      resumeFromFile(f).catch((err) => {
        log('✗ PDF 这条链子走不通：' + String((err && err.message) || err).slice(0, 180));
        log('→ 兜底：简历另存为 .txt 再选一次，或直接粘贴到下面文本框点「保存文本」。');
      });
    });
    $('#r_save', bodyEl).addEventListener('click', () => {
      cfg.resumeChars = Math.max(1000, Number($('#r_chars', bodyEl).value) || 6000); saveCfg();
      setResume($('#bgResume', bodyEl).value, '手动编辑');
    });
    $('#r_clear', bodyEl).addEventListener('click', () => { GM_deleteValue(K.resume); $('#bgResume', bodyEl).value = ''; updateResumeMeta(); log('简历缓存已清除'); });
    $('#r_pdfinfo', bodyEl).addEventListener('click', () => selfCheckPdf());
  }

  /* ---- 岗位页 ---- */
  function renderJobsTab() {
    bodyEl.innerHTML =
      '<fieldset><legend>抓取收藏岗位</legend>' +
      '<div class="hint">先在网页版进入你的「收藏/沟通过」列表页，把页面<strong>滚到底</strong>（懒加载全部出来后）再点按钮。脚本用 DOM 识别岗位卡片，不依赖具体接口参数，改版了也大概率能用。</div>' +
      '<div class="btns"><button class="act pri" id="j_here">抓当前页</button>' +
      '<button class="act" id="j_pages">自动翻页抓</button><input id="j_np" value="3" style="flex:0 0 54px">' +
      '<button class="act" id="j_detail">抓选中岗位详情</button></div>' +
      '<div class="btns"><button class="act" id="j_all">全选/取消</button><button class="act warn" id="j_clear">清空列表</button></div>' +
      '<label class="mini">选中 = 加入队列。取消勾选会立刻丢掉那条<strong>未发送</strong>的草稿（已发送的保留，避免重复发同一个 HR）。</label>' +
      '</fieldset><div id="j_list"></div>';

    $('#j_here', bodyEl).addEventListener('click', () => scrapeCurrentPage());
    $('#j_pages', bodyEl).addEventListener('click', () => scrapeWithPagination(Math.min(20, Number($('#j_np', bodyEl).value) || 3)));
    $('#j_detail', bodyEl).addEventListener('click', () => fetchDetails(selected()));
    $('#j_clear', bodyEl).addEventListener('click', () => {
      const n = Object.keys(drafts).length;
      if (!confirm('清空已抓的岗位、详情和 ' + n + ' 条草稿缓存？')) return;
      jobs = []; details = {}; drafts = {};
      Object.keys(states).forEach((k) => delete states[k]);
      save(K.jobs, jobs); save(K.details, details); save(K.drafts, drafts);
      renderJobsTab();
      log('岗位列表、详情、草稿缓存已全部清空');
    });
    // 注意：JS 直接改 checkbox.checked 不会触发 change，所以状态必须在这里显式写回，
    // 否则「全选/取消」只是视觉变化，selected() 仍然是老样子，队列页不会跟着变。
    $('#j_all', bodyEl).addEventListener('click', () => {
      const allOn = jobs.length > 0 && jobs.every((j) => j.sel !== false);
      setSelMany(jobs.map((j) => j.id), !allOn);
      drawJobList();
    });
    drawJobList();
  }

  function drawJobList() {
    const list = $('#j_list', bodyEl);
    if (!list) return;
    if (!jobs.length) { list.innerHTML = '<div class="mini">还没有岗位数据</div>'; return; }
    list.innerHTML = jobs.map((j) => {
      return '<div class="job"><input type="checkbox" data-id="' + esc(j.id) + '" ' + (j.sel === false ? '' : 'checked') + ' style="flex:0 0 auto;width:auto;margin-top:4px">' +
        '<div class="t"><b>' + esc(j.title || '(未识别标题)') + '</b>' +
        '<i>' + esc([j.company, j.salary, j.city].filter(Boolean).join(' · ')) + '</i>' +
        '<i class="mini">' + esc(jobMeta(j.id)) + '</i></div></div>';
    }).join('');
    // 勾选变化是唯一的状态入口：写回 job.sel + 落存储 + 丢掉未发送草稿 + 刷队列页/标题栏
    $$('input[type=checkbox]', list).forEach((b) => b.addEventListener('change', () => {
      setSel(b.dataset.id, b.checked);
      const row = b.closest ? b.closest('.job') : null;
      const mini = row && row.querySelector('.mini');
      if (mini) mini.textContent = jobMeta(b.dataset.id);
    }));
  }

  function jobMeta(id) {
    const has = details[id] && details[id].text ? '有详情' : '仅列表';
    const d = drafts[id];
    if (!d) return has;
    if (d.sent) return has + ' · 已发送';
    return has + (isDraftStale(id) ? ' · 草稿已过期' : ' · 有草稿');
  }

  // 岗位数据、详情回收、抓取结束都会调这里：岗位页和队列页一起刷，避免两页看到的状态不一致
  function renderJobs() {
    if (curTab === 'jobs') drawJobList();
    renderQueue();
    updateStat();
  }

  /* ---- 队列页 ---- */
  function renderQueue() {
    if (curTab !== 'queue') { updateStat(); return; }
    bodyEl.innerHTML =
      '<fieldset><legend>生成与发送</legend>' +
      '<div class="btns"><button class="act pri" id="q_run">' + (runner.running ? '停止批量' : '开始批量') + '</button>' +
      '<button class="act" id="q_pause">' + (runner.paused ? '继续' : '暂停') + '</button>' +
      '<span class="mini" style="flex:0 0 auto">' + (cfg.autoSend ? '全自动' : '半自动') + '</span></div>' +
      '<div class="hint">队列 = 「岗位」页里当前勾选的岗位（共 ' + selCount() + ' 个），取消勾选立刻从这里消失，未发送的草稿一并丢掉。' +
      (cfg.autoSend
        ? '当前是全自动：点「发送」或「开始批量」都会后台开该岗位的标签页，自动开沟通、填、发，你不用切页面。'
        : '当前是半自动：脚本只把草稿填进当前页的聊天输入框，由你审一遍再按 Enter 或点站点「发送」；当前页不是沟通页时它会明确告诉你，不会假装发成功。') +
      '</div>' +
      '</fieldset><div id="q_list"></div>';

    $('#q_run', bodyEl).addEventListener('click', () => {
      if (runner.running) { runner.running = false; log('已请求停止'); return; }
      const ids = selected().map((j) => j.id);
      if (!ids.length) { log('先在「岗位」页勾选要处理的岗位'); return; }
      runBatch(ids);
    });
    $('#q_pause', bodyEl).addEventListener('click', () => { runner.paused = !runner.paused; renderQueue(); log(runner.paused ? '已暂停' : '已继续'); });

    const list = $('#q_list', bodyEl);
    const sel = selected();
    if (!sel.length) { list.innerHTML = '<div class="mini">队列为空（去「岗位」页勾选）</div>'; return; }
    list.innerHTML = sel.map((j) => {
      const d = drafts[j.id];
      const stale = !!d && !d.sent && isDraftStale(j.id);   // 已发送的不催过期：反正不会再发第二次
      return '<div class="job" data-id="' + esc(j.id) + '"><div class="t"><b>' + esc(j.title) + '</b>' +
        '<i>' + esc([j.company, j.salary].filter(Boolean).join(' · ')) + '</i>' +
        (d ? '<div class="draft' + (stale ? ' stale' : '') + '">' + esc(d.text) + '</div>' : '') +
        (stale ? '<div class="mini warn">这条草稿是按旧简历/旧详情生成的，已失效，请重新生成后再发送</div>' : '') +
        '<div class="btns">' +
        '<button class="act gen">' + (d ? '重新生成' : '生成') + '</button>' +
        // 已发送的不再给「发送」按钮：重复给同一个 HR 发一遍算骚扰，也容易被风控
        (d && !stale && !d.sent ? '<button class="act snd">发送</button>' : '') +
        (d && d.sent ? '<span class="mini">' + (d.sentAt ? '已于 ' + esc(new Date(d.sentAt).toLocaleString()) + ' 发出' : '已发出，不再重复发送') + '</span>' : '') +
        (d ? '<button class="act cp">复制</button><button class="act warn drop">丢草稿</button>' : '') +
        '<button class="act rm">移出队列</button>' +
        '<span class="st ' + stateClass(j.id) + '">' + esc(stateOf(j.id)) + '</span>' +
        '</div></div></div>';
    }).join('');

    $$('.job', list).forEach((row) => {
      const id = row.dataset.id;
      const dp = $('.drop', row);
      if (dp) dp.addEventListener('click', () => {
        if (drafts[id] && drafts[id].sent) { log('· 这条已发送过，草稿留作记录；要清就点岗位页「清空列表」'); return; }
        dropDraft(id, '手动丢草稿');
        renderQueue();
      });
      // 队列页也能直接把岗位移出队列：等同于回岗位页取消勾选，未发送草稿一并丢掉
      const rm = $('.rm', row);
      if (rm) rm.addEventListener('click', () => setSel(id, false));
      $('.gen', row).addEventListener('click', (e) => {
        e.target.textContent = '生成中';
        generateOne(id).then((t) => { log('已生成：' + t.slice(0, 24) + '...'); renderQueue(); })
          .catch((er) => { log('✗ 生成失败：' + er.message); renderQueue(); });
      });
      const s = $('button.snd', row);   // 只认按钮：状态徽章以前也叫 .snd，点徽章会触发重发
      if (s) s.addEventListener('click', async (e) => {
        if (drafts[id] && drafts[id].sent) { log('· 「' + jobTitle(id) + '」已发送过，不重复发送'); renderQueue(); return; }
        e.target.textContent = '发送中';
        const job = jobs.find((j) => j.id === id) || {};
        let r;
        if (cfg.autoSend) {
          // 全自动：和「开始批量」走同一条路——后台开该岗位的标签页，在那边开沟通、填、发，
          // 不发当前页。旧版这里无视模式、只在当前页找输入框，于是设了全自动还得自己开沟通页。
          if (!/^https?:/.test(job.url || '')) r = { ok: false, why: '没有岗位链接，无法开后台标签发送' };
          else {
            log('· 全自动：开后台标签发送「' + jobTitle(id) + '」');
            r = await sendInJobTab(job, drafts[id].text);
          }
        } else {
          // 半自动：你现在就站在沟通页 → 当场填并发；不在 → 另开一个标签页走到这个岗位的
          // 沟通页，把话填好就停手，最后那一下「发送」留给你点。旧版这里只会甩一句
          // 「请先自己打开沟通页再点发送」，等于把最麻烦的一步推回给用户。
          r = await sendMessage(drafts[id].text);
          if (r.noComposer && /^https?:/.test(job.url || '')) {
            log('· 半自动：这一页不在沟通页，另开标签页走到这个岗位的沟通页只填不发');
            r = await sendInJobTab(job, drafts[id].text, true);
          } else if (r.noComposer) {
            r.why = '这一页没有聊天输入框，这条岗位又没有可打开的链接，只能你自己进沟通页再粘贴（复制按钮在草稿旁边）';
          }
        }
        if (r.ok) {
          drafts[id].sent = true; drafts[id].sentAt = Date.now();
          stats.sent++; save(K.drafts, drafts); save(K.stats, stats);
          // 模式标签跟着 cfg.autoSend 走。旧版这里写死了「半自动」，
          // 用户明明选了全自动，日志却说半自动，等于骗人。
          log('✓ 发送成功（' + (cfg.autoSend ? '全自动' : '半自动') +
            (r.how ? '，' + String(r.how).replace('button', '点按钮').replace('enter', '回车') : '') +
            '）：「' + jobTitle(id) + '」');
        } else if (r.filled) {
          // 只填没发：不算发送，不计数、不置「已发送」，按钮留着，用户可以发完再点一次变成功
          log('· 已填好待你确认：' + r.why);
          setJobState(id, '已填待确认');
        } else {
          log('✗ 发送未确认：「' + jobTitle(id) + '」' + r.why);
        }
        renderQueue();
      });
      const c = $('.cp', row);
      if (c) c.addEventListener('click', () => {
        navigator.clipboard.writeText(drafts[id].text).then(() => log('已复制到剪贴板'), () => log('剪贴板不可用，请手动选中文本复制'));
      });
    });
  }

  const states = {};
  function stateOf(id) {
    if (drafts[id] && drafts[id].sent) return '已发送';
    if (drafts[id] && isDraftStale(id)) return '草稿已过期';
    return states[id] || (drafts[id] ? '已生成' : '待处理');
  }
  function stateClass(id) {
    const s = stateOf(id);
    if (s === '已发送') return 'sent';   // 别用 'snd'：那是「发送」按钮的 class，撞了会让状态徽章变成可点的发送键
    if (s === '草稿已过期') return 'stale';
    if (s === '出错' || s === '发送失败') return 'err';
    if (s === '生成中' || s === '发送中' || s === '待确认' || s === '已填待确认') return 'run';
    return '';
  }
  function setJobState(id, s) { states[id] = s; renderQueue(); }

  /* ---- 日志页 ---- */
  function renderLog() {
    bodyEl.innerHTML =
      '<fieldset><legend>运行日志</legend>' +
      '<textarea id="bgLog" rows="18" readonly placeholder="日志会出现在这里">' + esc(logBuf.join('\n')) + '</textarea>' +
      '<div class="btns"><button class="act" id="l_clear">清空</button><button class="act" id="l_copy">复制全部</button><button class="act" id="l_reset">重置今日计数</button></div>' +
      '<div class="hint">日志不会打印 API Key。切标签、关面板都不会丢。</div></fieldset>';
    const box = $('#bgLog', bodyEl);
    box.scrollTop = box.scrollHeight;
    $('#l_clear', bodyEl).addEventListener('click', () => { logBuf.length = 0; box.value = ''; $('#bgFoot').textContent = '已清空'; });
    $('#l_copy', bodyEl).addEventListener('click', () => {
      box.select();
      try { document.execCommand('copy'); log('日志已复制到剪贴板'); }
      catch (e) { navigator.clipboard.writeText(logBuf.join('\n')).then(() => log('日志已复制'), () => log('复制失败，请手动全选')); }
    });
    $('#l_reset', bodyEl).addEventListener('click', () => { stats = { day: today(), sent: 0, generated: 0 }; save(K.stats, stats); updateStat(); log('今日计数已重置'); });
  }

  /* ---------------------------------------------------------------- 启动 */

  GM_registerMenuCommand('打开/显示助手面板', () => {
    if (!panel) buildPanel();
    panel.style.display = 'flex';
    const min = $('#bgMin'); if (min) min.style.display = 'none';
  });
  GM_registerMenuCommand('重置全部本地数据', () => {
    [K.cfg, K.resume, K.jobs, K.details, K.drafts, K.stats, K.pending].forEach((k) => GM_deleteValue(k));
    log('已清空，刷新页面生效');
  });

  function boot() {
    // ① 发送接力（点「立即沟通/继续沟通」会整页跳转）：跳过来的这一页必须最先认领这条接力，
    //    因为此时 URL 上的 ?jobId= 已经被站点洗掉，sendReq 那条精确比对再也匹配不上。
    const hop = readHop();
    if (hop && looksLikeChat()) {
      (async () => {
        await sleep(rnd(1200, 2200));      // 等沟通页把会话选中、把输入框渲染出来
        const r = await runHopSend(hop);
        // 只有关闭开关打开、而且真的发出去了，才把这个标签页收掉；
        // 失败时必须留着页面，用户要看得见到底卡在哪一步，不然就是「悄悄失败」。
        if (cfg.autoCloseDetail && r && r.ok) setTimeout(() => { try { window.close(); } catch (e) {} }, 2500);
      })();
      return;
    }
    // ② 「被脚本开出来发送」的标签页优先级最高。它的 URL 往往同时也躺在详情待抓队列里，
    //    旧版先判详情，于是这个标签页去抓详情、把自己关了，发送从来没发生 → 发送方干等超时。
    const req = GM_getValue('sendReq', null);
    if (req && req.url && sameJobPage(req.url, location.href)) {
      maybeHandleSendRequest();
      return;   // 发送用的标签页不建面板，免得用户以为要在这儿操作
    }
    // 后台标签页：被脚本打开时自动抓详情，不显示面板
    const hit = isDetailTab();
    if (hit) {
      (async () => {
        await sleep(rnd(2000, 3500));
        const n = scrapeDetail(hit.id);
        log('详情页抓取完成：' + n + ' 字 -> ' + hit.url);
        if (cfg.autoCloseDetail) setTimeout(() => { try { window.close(); } catch (e) {} }, 800);
      })();
      return;
    }

    buildPanel();
    // 跨标签数据回收：轮询 GM 存储
    setInterval(() => {
      const d = load(K.details, {}) || {};
      let changed = false;
      Object.keys(d).forEach((k) => { if (!details[k]) { details[k] = d[k]; changed = true; } });
      if (changed) { save(K.details, details); renderJobs(); }
      const p = load(K.pending, []) || [];
      if (p.length !== pending.length) pending = p;
    }, 2000);

    if (getResume()) log('已加载简历缓存 ' + getResume().length + ' 字');
    log('面板已就绪（脚本 v' + VER + '）。快捷键 Alt+P 显示/隐藏');
  }

  document.addEventListener('keydown', (e) => {
    if (e.altKey && (e.key === 'p' || e.key === 'P')) {
      if (!panel) buildPanel();
      else { const on = panel.style.display !== 'none'; panel.style.display = on ? 'none' : 'flex'; $('#bgMin').style.display = on ? 'block' : 'none'; }
      e.preventDefault();
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
