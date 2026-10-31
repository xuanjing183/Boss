/*
 * 从 boss-zhipin-llm-greet.user.js 里切出 SCRAPER-BEGIN/END 之间的抓取代码，
 * 注入到 test/scraper-test.html，用一屏仿真的岗位卡片 DOM 做断言。
 * 用法：node test/build-test.js   （改完脚本的选择器逻辑后重跑一次）
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'boss-zhipin-llm-greet.user.js'), 'utf8');

const m = src.match(/\/\* SCRAPER-BEGIN[\s\S]*?\n([\s\S]*?)\/\* SCRAPER-END \*\//);
if (!m) {
  console.error('没找到 SCRAPER-BEGIN / SCRAPER-END 标记');
  process.exit(1);
}
const code = m[1].replace(/<\/script>/g, '<\\/script>');

const shims = `
      var jobs = [];
      var K = { jobs: 'jobs' };
      function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
      function $(s, r) { return (r || document).querySelector(s); }
      function visible(el) { if (!el) return false; var b = el.getBoundingClientRect();
        return b.width > 4 && b.height > 4 && el.offsetParent !== null && !el.disabled; }
      function notMine(el) { return !(el.closest && el.closest('#bgPanel, #bgMin')); }
      function log(msg) { (window.__logs = window.__logs || []).push(msg); }
      function save() {} function renderJobs() {}
      // v0.5.4：scrapeCurrentPage 不再 save(K.jobs, jobs) 整块盖，改叫 saveJobs()（读回存储、按 id
      // 取并集）。并集本身在抽取区外面，由 ui-smoke ⑧ 钉着；这一层只钉「抓取确实走了那条路」。
      function saveJobs() { window.__savedJobs = (window.__savedJobs || 0) + 1; }
      function pruneDrafts() { window.__pruned = (window.__pruned || 0) + 1; }
      function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
      function rnd(a, b) { return Math.floor(a + Math.random() * (b - a)); }
      function clamp(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; }
`;

const fixture = `
  <div class="layout">
    <div class="job-list-box">
      <div class="job-card-wrap"><div class="job-card-body"><div class="info-primary">
        <div class="job-name"><a class="job-title-link" href="/job_detail/aaa111.html">Java 后端工程师</a></div>
        <div class="salary-wrap"><span class="salary">20-35K·14薪</span></div>
        <div class="company-wrap"><a class="company-name" href="/gongsi/beijing.html">北京某某网络科技有限公司</a></div>
        <div class="company-location">海淀·中关村</div>
        <div class="tag-list"><span>Java</span><span>Spring</span><span>五险一金</span></div>
      </div></div></div>

      <div class="job-card-wrap"><div class="job-card-body"><div class="info-primary">
        <div class="job-name"><a class="job-title-link" href="/job_detail/bbb222.html">前端开发工程师（React）</a></div>
        <div class="salary-wrap"><span class="salary">15-25K</span></div>
        <div class="company-wrap"><a class="company-name" href="/gongsi/shanghai.html">上海某智能科技有限公司</a></div>
        <div class="company-location">浦东·张江</div>
        <div class="tag-list"><span>React</span><span>TypeScript</span></div>
      </div></div></div>

      <div class="job-card-wrap"><div class="job-card-body"><div class="info-primary">
        <div class="job-name"><a class="job-title-link" href="/web/geek/job_detail?ccm=ccc333&amp;id=ccc333">数据平台研发</a></div>
        <div class="salary-wrap"><span class="salary">25-50K·16薪</span></div>
        <div class="company-line"><span>杭州某数据有限公司</span></div>
        <div class="company-location">滨江·网商路</div>
        <div class="tag-list"><span>Flink</span><span>数仓</span></div>
      </div></div></div>

      <div class="job-card-wrap no-salary"><div class="job-card-body"><div class="info-primary">
        <div class="job-name"><a class="job-title-link" href="/job_detail/ddd444.html">运维工程师（面议）</a></div>
        <div class="company-wrap"><a class="company-name" href="/gongsi/chengdu.html">成都某网络安全有限公司</a></div>
      </div></div></div>

      <!-- 收藏/感兴趣列表的真实写法：标题链接里把地点用方括号拼在后面。
           混进标题会污染提示词，更会让沟通页的职位名比对失败（沟通页只有纯标题）。 -->
      <div class="job-card-wrap"><div class="job-card-body"><div class="info-primary">
        <div class="job-name"><a class="job-title-link" href="/job_detail/fff666.html">28届后端实习生-示例短视频 [ 上海·浦东新区 ]</a></div>
        <div class="salary-wrap"><span class="salary">200-250元/天</span></div>
        <div class="company-wrap"><a class="company-name" href="/gongsi/example.html">示例网络科技有限公司</a></div>
      </div></div></div>
    </div>

    <!-- 真实收藏页右侧还有「谁看过我 / 对我感兴趣的」两块推荐。里面的岗位同样是
         a[href*=job_detail]，旧版整页扫描会把它们一起抓进来（用户截图里打叉的那几条）。
         侧栏比主列窄得多，而且有固定标题 —— 这两条线索就是下面两道路标。 -->
    <div class="side-col">
      <div class="side-mod">
        <h3>谁看过我</h3>
        <div class="side-card"><a class="job-title-link" href="/job_detail/side111.html">Golang 服务端开发（侧栏1）</a><div>10-15K</div></div>
        <div class="side-card"><a class="job-title-link" href="/job_detail/side222.html">测试开发工程师（侧栏2）</a></div>
      </div>
      <div class="side-mod">
        <h3>对我感兴趣的</h3>
        <div class="side-card"><a class="job-title-link" href="/job_detail/side333.html">推荐算法工程师（侧栏3）</a></div>
      </div>
    </div>
  </div>

    <div class="page-wrap"><a class="next" href="#" aria-disabled="false">下一页</a></div>
    <a class="noise" href="/web/geek/job?query=java&amp;position=100000">这是搜索页链接，不该被抓到</a>
    <a class="noise2" href="/waimao/job_detail/eee555.html" style="display:none">隐藏卡片，不该算可见</a>
`;

const asserts = `
      window.__run = function () {
        var out = [];
        var add = function (name, pass, extra) { out.push({ name: name, pass: !!pass, extra: extra === undefined ? '' : String(extra) }); };

        window.__X.scrapeCurrentPage();
        var js = window.__X.jobs;
        var logs = (window.__logs || []).join('\\n');
        var byTitle = function (t) { return js.filter(function (x) { return x.title.indexOf(t) >= 0; })[0] || {}; };

        add('抓到 5 个岗位（含 1 个面议 + 1 个收藏列表写法）', js.length === 5, '实际 ' + js.length + '：' + js.map(function (j) { return j.title; }).join(' / '));
        add('忽略搜索页链接 /web/geek/job?query=', js.every(function (j) { return !/job\\?/.test(j.url); }), js.map(function (j) { return j.url; }).join(' '));

        // 用户图2打叉的那几条：右侧「谁看过我 / 对我感兴趣的」里也有 a[href*=job_detail]，
        // 旧版整页扫 a 标签，把它们当成收藏岗位一起抓了。现在只认主列表容器。
        add('右侧「谁看过我 / 对我感兴趣的」里的岗位一条都没抓',
          js.every(function (j) { return !/（侧栏\\d）/.test(j.title) && !/^side/.test(j.id); }),
          js.map(function (j) { return j.id + ':' + j.title; }).join(' / '));
        add('日志说清只取职位收藏主列表、忽略了右侧推荐',
          /本页只取职位收藏主列表/.test(logs) && /已忽略「谁看过我 \\/ 对我感兴趣的」侧栏/.test(logs),
          (logs.match(/[^\\n]*主列表[^\\n]*/) || ['无'])[0]);

        var j1 = byTitle('Java 后端');
        add('标题正确', j1.title === 'Java 后端工程师', j1.title);
        add('薪资正确', /20-35K/.test(j1.salary || ''), j1.salary);
        add('公司正确', /某某网络科技/.test(j1.company || ''), j1.company);
        add('城市正确', /海淀·中关村/.test(j1.city || ''), j1.city);
        add('标签含 Spring', (j1.tags || []).indexOf('Spring') >= 0, (j1.tags || []).join(','));
        add('标签未被合并成串', (j1.tags || []).every(function (t) { return !/JavaSpring/.test(t); }), (j1.tags || []).join(','));
        add('岗位之间文本不串味', !/前端开发/.test(j1.text || ''), clamp(j1.text, 120));

        var j3 = byTitle('数据平台');
        add('id 型链接解析出 id', j3.id === 'ccc333', j3.id);
        add('无公司链接时从文本取公司', /某数据有限公司/.test(j3.company || ''), j3.company);

        var j4 = byTitle('运维');
        add('面议岗位仍入库', !!j4.title, JSON.stringify({ t: j4.title, s: j4.salary }));

        // 收藏/感兴趣列表把地点用方括号拼在标题里：混进标题会污染提示词，
        // 更会让沟通页的职位名比对失败（沟通页只渲染纯标题）—— 用户日志里那句「认不出当前会话」的根因。
        var j5 = byTitle('示例短视频');
        add('收藏列表的标题会剥掉尾部地点括号', j5.title === '28届后端实习生-示例短视频', JSON.stringify(j5.title));
        add('剥下来的地点回填到城市，信息不丢', /上海·浦东新区/.test(j5.city || ''), j5.city);
        add('岗位 id 不受标题清洗影响', j5.id === 'fff666', j5.id);
        add('圆括号里的限定语不当地点（（面议）/（React）原样保留）',
          j4.title === '运维工程师（面议）' && byTitle('前端开发工程师').title === '前端开发工程师（React）',
          JSON.stringify([j4.title, byTitle('前端开发工程师').title]));

        var nb = window.__X.findNextButton();
        add('找到下一页按钮', !!nb && /next/.test(nb.className), nb ? nb.className : 'null');
        add('id 去重', js.length === new Set(js.map(function (j) { return j.id; })).size, js.map(function (j) { return j.id; }).join(','));

        // 选中状态 = 队列成员资格。v0.5.1：抓回来只是入库、默认不勾选（勾上才进队列、才自动抓详情），
        // 而重抓既不能把用户勾上的抹掉，也不能把没勾的塞进队列。
        add('新抓到的岗位默认不勾选（抓回来只是入库，勾上才算要处理）', js.length > 0 && js.every(function (j) { return j.sel === false; }),
          js.map(function (j) { return j.sel; }).join(','));
        add('抓取后清了孤儿草稿', (window.__pruned || 0) >= 1, 'pruneDrafts 调用 ' + (window.__pruned || 0) + ' 次');
        add('抓取后按并集写回岗位列表（走 saveJobs 那条路，不再整块盖别人的岗位）',
          (window.__savedJobs || 0) >= 1, 'saveJobs 调用 ' + (window.__savedJobs || 0) + ' 次');
        js[0].sel = true;   // 模拟用户勾了第一条，其余保持没勾
        var addedAgain = window.__X.scrapeCurrentPage(true);
        add('重抓同一页不产生重复岗位', window.__X.jobs.length === js.length && addedAgain === 0,
          '累计 ' + window.__X.jobs.length + '，本次新增 ' + addedAgain);
        add('重抓不抹掉用户勾上的、也不把没勾的塞进队列',
          window.__X.jobs[0].sel === true && window.__X.jobs.slice(1).every(function (j) { return j.sel === false; }),
          window.__X.jobs.map(function (j) { return j.sel; }).join(','));
        add('重抓会刷新岗位文本/薪资', !!window.__X.jobs[0].title && window.__X.jobs[0].id === js[0].id, window.__X.jobs[0].title);

        // 站点改版、主列表 class 认不出来：退回整页扫 a 标签，但「卡片宽度」这道兜底必须把侧栏窄卡片挡掉。
        // 宁可少抓，也不能像旧版那样把右侧推荐混进来。新塞的「猜你喜欢」故意不叫「谁看过我」，
        // 这样侧栏标题那道闸门帮不上忙，只有宽度判据能挡住它。
        document.querySelector('.job-list-box').className = 'mystery-list';
        document.querySelector('.side-col').insertAdjacentHTML('beforeend',
          '<div class="guess-mod"><h3>猜你喜欢</h3><div class="side-card">' +
          '<a class="job-title-link" href="/job_detail/side999.html">云原生开发工程师（猜你喜欢）</a></div></div>');
        var logMark = (window.__logs || []).length;
        var addedFB = window.__X.scrapeCurrentPage();
        var fbLog = (window.__logs || []).slice(logMark).join('\\n');
        add('认不出主列表容器时按卡片宽度兜底：主列 5 条照常在，侧栏窄卡片一条不进',
          addedFB === 0 && window.__X.jobs.length === 5 &&
          !window.__X.jobs.some(function (j) { return j.id === 'side999'; }),
          '新增 ' + addedFB + '，累计 ' + window.__X.jobs.length + '：' + window.__X.jobs.map(function (j) { return j.id; }).join(','));
        add('兜底路径在日志里说明白（没认出容器、按宽度排除了几张）',
          /按侧栏标题\\/卡片宽度过滤/.test(fbLog) && /排除 1 个侧栏窄卡片/.test(fbLog),
          (fbLog.match(/[^\\n]*主列表[^\\n]*/) || ['无'])[0]);
        return out;
      };
`;

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>scraper 回归测试</title>
<style>
body{font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;margin:24px;color:#222}
.fixture{border:1px dashed #ccd;background:#fbfcff;padding:10px;margin-bottom:16px}
/* 主列宽、侧栏窄：宽度本身就是「侧栏兜底」判据的输入，别改成百分比五五开 */
.layout{display:flex;gap:20px;align-items:flex-start}
.job-list-box{flex:0 0 68%}
/* 改版后的容器：class 认不得，但还占着主列那么宽 —— 兜底判据靠的就是这个宽度差 */
.mystery-list{flex:0 0 68%}
.side-col{flex:0 0 28%}
.side-card{margin:8px 0}
.side-mod{margin-bottom:12px}
table{border-collapse:collapse;width:100%}
th,td{border-bottom:1px solid #eee;padding:6px 8px;text-align:left;vertical-align:top}
.pass{color:#1c8a45;font-weight:600}.fail{color:#c8402f;font-weight:600}
.extra{color:#7a8698;font-size:12px;word-break:break-all}
#sum{font-size:16px;margin:10px 0}
</style></head>
<body>
<h3>BOSS 岗位抓取逻辑 · DOM 回归测试</h3>
<div id="sum">运行中…</div>
<table><thead><tr><th style="width:34%">断言</th><th style="width:8%">结果</th><th>实际值</th></tr></thead><tbody id="rows"></tbody></table>
<h4>仿真 DOM（fixture）</h4>
<div class="fixture" id="fixture">${fixture}</div>
<script>
(function () {
  ${shims}
  // ---- 以下是从 .user.js 的 SCRAPER-BEGIN/END 之间原样切出的生产代码 ----
${code.replace(/^/gm, '  ')}
  window.__X = { scrapeCurrentPage: scrapeCurrentPage, findNextButton: findNextButton, parseJobCard: parseJobCard, jobIdFromHref: jobIdFromHref, get jobs() { return jobs; } };
${asserts.replace(/^/gm, '  ')}
  var res = [];
  try { res = window.__run(); }
  catch (e) { res.push({ name: '测试执行自身抛错', pass: false, extra: (e && e.message) + ' @ ' + String((e && e.stack) || '').split(String.fromCharCode(10))[1] }); }
  window.__RESULT = { total: res.length, failed: res.filter(function (r) { return !r.pass; }).length, detail: res };
  document.getElementById('rows').innerHTML = res.map(function (r) {
    return '<tr><td>' + r.name + '</td><td class="' + (r.pass ? 'pass">PASS' : 'fail">FAIL') + '</td><td class="extra">' +
      String(r.extra).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</td></tr>';
  }).join('');
  var bad = window.__RESULT.failed;
  document.getElementById('sum').innerHTML = bad ? '<span class="fail">' + bad + ' 项失败</span> / 共 ' + res.length + ' 项' :
    '<span class="pass">全部 ' + res.length + ' 项通过</span>';
})();
<\/script>
</body></html>
`;

fs.writeFileSync(path.join(root, 'test', 'scraper-test.html'), html);
console.log('生成 test/scraper-test.html，注入生产代码 ' + code.split('\n').length + ' 行');
