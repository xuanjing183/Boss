// ==UserScript==
// @name         BOSS直聘 · 岗位筛选与打招呼助手
// @namespace    qoder.boss.assistant
// @version      0.7.1
// @description  两部分功能：(1) 按薪资/时长/出勤/招聘者活跃度/简历匹配度自动筛选并收藏岗位；(2) 读取收藏的岗位，连同本地简历一起交给大模型生成个性化打招呼语，再半自动/自动发送给 HR
// @match        https://www.zhipin.com/*
// @match        https://*.zhipin.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
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
 *
 * v0.7.0 两部分功能：
 *   第一部分【筛选】：在「筛选」tab 配置口径/目标数，打开 BOSS 实习列表页后点「开始筛选当前页」，
 *                    脚本自动按日薪/时长/出勤/招聘者活跃度/简历匹配度过滤，
 *                    合格的点收藏，不合格的跳过并记录原因。
 *   第二部分【打招呼】：在「岗位」tab 抓取收藏的岗位 → 「队列」tab 生成招呼语 → 发送。
 *
 * 首次使用顺序：
 *   1) 「设置」tab 填 API Key / Model
 *   2) 「简历」tab 选 PDF 或粘文本
 *   3) 「筛选」tab 配置口径，开始筛选并收藏
 *   4) 收藏完成后，去「岗位」tab 抓当前页（BOSS 收藏列表页）
 *   5) 勾上要处理的岗位 → 「队列」tab 生成 → 发送
 */
(function () {
  'use strict';

  // 版本号跟上面 @version 保持一致：面板标题和启动日志都会打出来，
  // 方便确认「油猴里跑的到底是哪一版」（改完脚本忘了替换是最常见的坑）。
  const VER = '0.7.1';

  /* ---------------------------------------------------------------- 配置存储 */

  const K = {
    cfg: 'cfg',
    resume: 'resumeText',
    jobs: 'jobs',
    details: 'details',
    drafts: 'drafts',
    stats: 'stats',
    pending: 'pendingDetails',
    batch: 'bgBatch',       // 正在跑的批量计划（整页跳转后新页面靠它接着跑）
    logbuf: 'bgLogBuf',     // 日志在油猴存储里的那份副本（整页跳转不会把历史留在内存里）
    exec: 'bgExec',         // 面板递给「生成器」标签页的交接单（跑哪几条、被谁认领了）
    execLog: 'bgLogExec',   // 生成器那一页自己的日志副本（和面板那份分开，两边不互相盖）
    // v0.7.0 筛选功能新增
    scoutCfg: 'scoutCfg',   // 筛选配置（口径、目标数）
    scoutProgress: 'scoutProgress', // 筛选进度（已收藏、已跳过、当前状态）
    scoutReport: 'scoutReport'      // 筛选报告（本轮收藏的岗位清单）
  };
  // 「这条岗位真的发出去了」的持久凭证。发送成功的确认方可能是后台那个标签页，
  // 而把草稿标成「已发送」的是面板这一页 —— 面板半路被跳转销毁时，标记就丢了，
  // 续跑时会对着同一个 HR 再发一遍。所以确认方必须自己留一份谁都看得见的记录。
  const SENT_KEY = (id) => 'bgSent:' + id;

  /* ---------------- v0.5.5：这一页是不是脚本开出来的「生成器」标签页 ----------------
   * 用户要的是「即使我离开了，语句生成也不能被打断」。这句话只能这样兑现：跑循环的那一页
   * 必须是他永远不会跳走的一页，也就是脚本自己开、自己认、用完自己关的那个后台标签页。
   * 生成招呼语只需要油猴存储（简历、JD、岗位、提示词）+ 一个到大模型的 HTTP 请求，完全不需要
   * DOM —— 所以那件事根本不该长在用户正在看的页面上。
   * 身份标记走 URL，和发送用的 #bgSend= 同一套手法（站点是 SPA，hash 可能被抹掉，
   * 所以再看一眼导航计时里最初那一跳的完整地址）。
   */
  const EXEC_MARK = 'bgExec=';
  const EXEC_TITLE = '招呼语生成器 · 请别关这个标签页';
  function execMarkToken() {
    const re = /bgExec=([a-z0-9]+)/;
    const m = re.exec(String(location.hash || ''));
    if (m) return m[1];
    try {
      const n = (performance.getEntriesByType('navigation') || [])[0];
      const m2 = re.exec(String((n && n.name) || ''));
      return m2 ? m2[1] : '';
    } catch (e) { return ''; }
  }
  const execToken = execMarkToken();
  // 标记在地址上就按生成器记账（哪怕后来认领失败）：日志写到哪一份，不能等认领结果出来才定。
  let isExec = !!execToken;

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
    genConcurrency: 3,        // 同时挂出去的大模型请求数（只并发生成；发送照旧串行 + 间隔）
    models: [],               // 多模型并行配置 [{apiBase, apiKey, model}, ...]，为空则用上面单 Key 兜底
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
    autoOpenChat: true,       // true  = 自动点「立即沟通」再发送
    sendViaList: true,        // 发送优先在后台标签的「列表页卡片」上点沟通入口（少开一次详情页）；走不通自动退回详情页入口
    autoCloseDetail: true,    // 抓完详情自动关掉那个后台标签页
    autoFetchDetail: true,    // 抓完列表自动开后台标签进详情页抓 JD（没 JD 的岗位不会生成招呼语）
    autoResume: true,         // 整页跳转把批量打断后，新页面自动接着跑上一轮剩下的岗位
    bgExecutor: true,         // 批量交给脚本自己开的后台「生成器」标签页跑：你在 BOSS 里怎么跳都不打断生成
    pdfWorkerSrc: 'https://registry.npmmirror.com/pdfjs-dist/3.11.174/files/legacy/build/pdf.worker.min.js',
    pdfTimeoutMs: 25000       // 单种 worker 方案的最长耗时，超时自动换下一条路（避免静默卡死）
  };

  /* ============ v0.7.1：薪资字体混淆破解 ============
   * BOSS直聘使用自定义字体（kanzhun-Regular/kanzhun-mix）混淆薪资数字：
   * DOM 中包含 Unicode 私有区字符（PUA），如  (U+E0B2 U+E0B6 U+E0B1) = 261
   * 字体将这些字符渲染为数字字形。
   * 解决方案：解码 PUA 字符为真实数字。
   */
  
  // PUA 字符到数字的映射（基于观察：U+E0B0=0, U+E0B1=1, ..., U+E0B9=9）
  // 注意：实际编码范围可能不同，需要动态检测
  const PUA_TO_DIGIT = {};
  
  // 初始化映射（覆盖常见 PUA 数字范围）
  for (let i = 0; i <= 9; i++) {
    // 尝试多个可能的范围
    const ranges = [0xE000, 0xE010, 0xE020, 0xE030, 0xE040, 0xE050, 0xE060, 0xE070, 0xE080, 0xE090, 0xE0A0, 0xE0B0, 0xE0C0, 0xE0D0, 0xE0E0, 0xE0F0];
    for (const base of ranges) {
      PUA_TO_DIGIT[String.fromCharCode(base + i)] = String(i);
    }
  }

  // 解码 PUA 字符为真实数字
  function decodePUASalary(text) {
    if (!text) return text;
    
    // 调试：记录 PUA 字符的实际编码
    const puaChars = text.match(/[\uE000-\uE0FF]/g);
    if (puaChars && puaChars.length > 0) {
      const codeInfo = puaChars.slice(0, 10).map(ch => {
        const code = ch.charCodeAt(0);
        const lastDigit = code & 0xF;
        const realDigit = (lastDigit - 1 + 10) % 10;
        return `${ch}(U+${code.toString(16).toUpperCase().padStart(4,'0')}, last=${lastDigit}→${realDigit})`;
      }).join(', ');
      log('[SalaryAPI] PUA codes: ' + codeInfo);
    }
    
    // 替换所有 PUA 字符（U+E000-U+E0FF）
    // 映射规律：实际数字 = (last_hex_digit - 1 + 10) % 10
    return text.replace(/[\uE000-\uE0FF]/g, (ch) => {
      const code = ch.charCodeAt(0);
      const lastDigit = code & 0xF;
      const realDigit = (lastDigit - 1 + 10) % 10;
      return String(realDigit);
    });
  }

  const salaryCache = new Map();  // jobId -> { low, high, unit }

  // 从 API 响应中提取薪资数据
  function extractSalaryFromResponse(url, data) {
    try {
      // 岗位列表 API
      if (url.includes('/wapi/zpgeek/search/joblist.json') || url.includes('/web/geek/job')) {
        const jobs = data?.zpData?.jobList || data?.data?.jobList || [];
        for (const job of jobs) {
          if (job.encId || job.jobId) {
            const id = job.encId || job.jobId;
            if (job.salaryDesc) {
              // salaryDesc 格式: "150-170元/天" 或 "15-20K" 等
              const m = /(\d+(?:\.\d+)?)\s*[-~—]\s*(\d+(?:\.\d+)?)/.exec(job.salaryDesc);
              if (m) {
                salaryCache.set(id, {
                  low: parseFloat(m[1]),
                  high: parseFloat(m[2]),
                  unit: job.salaryDesc.includes('天') ? 'day' : (job.salaryDesc.includes('月') ? 'month' : 'unknown'),
                  raw: job.salaryDesc
                });
              }
            }
          }
        }
      }
      // 岗位详情 API
      else if (url.includes('/wapi/zpgeek/job/detail.json') || url.includes('/job_detail')) {
        const job = data?.zpData?.jobInfo || data?.data?.jobInfo || {};
        if (job.encId || job.jobId) {
          const id = job.encId || job.jobId;
          if (job.salaryDesc) {
            const m = /(\d+(?:\.\d+)?)\s*[-~—]\s*(\d+(?:\.\d+)?)/.exec(job.salaryDesc);
            if (m) {
              salaryCache.set(id, {
                low: parseFloat(m[1]),
                high: parseFloat(m[2]),
                unit: job.salaryDesc.includes('天') ? 'day' : (job.salaryDesc.includes('月') ? 'month' : 'unknown'),
                raw: job.salaryDesc
              });
            }
          }
        }
      }
    } catch (e) {
      log('[SalaryAPI] Error: ' + e.message);
    }
  }

  // 拦截 fetch 请求（使用 unsafeWindow 访问页面的真实 fetch）
  const originalFetch = unsafeWindow.fetch;
  unsafeWindow.fetch = function(...args) {
    const url = String(args[0] || '');
    return originalFetch.apply(this, args).then((response) => {
      if (url.includes('zhipin.com') && (url.includes('joblist') || url.includes('job/detail'))) {
        log('[SalaryAPI] fetch matched: ' + url);
        response.clone().json().then((data) => {
          extractSalaryFromResponse(url, data);
        }).catch((e) => log('[SalaryAPI] fetch json error: ' + e.message));
      }
      return response;
    });
  };

  // 拦截 XMLHttpRequest（使用 unsafeWindow 访问页面的真实 XHR）
  const originalXHROpen = unsafeWindow.XMLHttpRequest.prototype.open;
  const originalXHRSend = unsafeWindow.XMLHttpRequest.prototype.send;
  unsafeWindow.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._url = String(url || '');
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };
  unsafeWindow.XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      if (this._url && this._url.includes('zhipin.com') &&
          (this._url.includes('joblist') || this._url.includes('job/detail'))) {
        log('[SalaryAPI] XHR matched: ' + this._url);
        try {
          const data = JSON.parse(this.responseText);
          extractSalaryFromResponse(this._url, data);
        } catch (e) {
          log('[SalaryAPI] XHR parse error: ' + e.message);
        }
      }
    });
    return originalXHRSend.apply(this, args);
  };

  // 从缓存获取薪资（优先使用 API 数据，降级使用 DOM 文本）
  function getSalaryForJob(jobId, domSalaryText) {
    log('[SalaryAPI] getSalaryForJob, jobId: ' + jobId + ', cache size: ' + salaryCache.size);
    const cached = salaryCache.get(jobId);
    if (cached) {
      log('[SalaryAPI] Cache hit: ' + jobId + ' -> ' + cached.raw);
      return cached.raw;  // 返回真实薪资字符串
    }
    log('[SalaryAPI] Cache miss: ' + jobId + ', using DOM: ' + domSalaryText);
    return domSalaryText;  // 降级使用 DOM 文本（可能被混淆）
  }

  /* ============ v0.7.0：岗位筛选功能（第一部分：筛选并收藏） ============
   * 基于 boss-intern-scout 插件的筛选口径，在油猴脚本里实现：
   * - 在 BOSS 实习列表页自动筛选符合要求的岗位
   * - 点击收藏按钮
   * - 记录筛选报告（通过/跳过/原因）
   * 筛选口径（硬性，按顺序判）：
   * 1. 时长 ≤3 个月
   * 2. 平均日薪 ≥200（中值计算）
   * 3. 出勤 ≤5 天/周
   * 4. 招聘者状态：在线/今日活跃/昨日活跃
   * 5. 简历匹配度（关键词命中）
   * 6. 无硬伤（届别/院校/方向/经验/时长）
   */

  // 筛选默认配置
  const SCOUT_DEFAULTS = {
    targetCount: 20,          // 目标收藏数
    // 筛选口径
    maxMonths: 3,             // 实习时长上限（月）
    minDailySalary: 200,      // 最低日薪（中值）
    maxDaysPerWeek: 5,        // 每周出勤上限
    // HR 活跃度筛选（勾选的才通过）
    hrActiveStatus: ['在线', '刚刚活跃', '今日活跃', '昨日活跃', '3日内活跃', '本周活跃'],
    // 招聘者活跃度（按优先级排序）
    recruiterStatus: ['在线', '今日活跃', '昨日活跃'],
    recruiterStatusSoft: ['刚刚活跃', '最新活跃'],  // 可用但需标注
    // 简历关键词（两条线）
    javaKeywords: ['Spring', 'SpringBoot', 'SpringBoot', 'Spring Cloud', 'MyBatis', 'Redis', 'MySQL', 'MQ', 'Kafka', 'Elasticsearch', '微服务', 'JVM', '分布式', 'Java'],
    aiKeywords: ['LangGraph', 'LangChain', 'RAG', 'Agent', 'Prompt', 'Function Calling', '向量', 'Milvus', 'Qdrant', 'pgvector', 'FastAPI', 'SSE', '大模型', 'AI'],
    // 硬伤关键词
    hardInjuries: ['2027届', '2026届', '27届', '26届', '985', '211', '双一流', '硕士', '博士', 'C++', '算法研究', '纯前端', '硬件', '嵌入式', '测试'],
    hardInjuriesEnabled: true,   // 硬伤关键词开关
    // 运行控制
    autoScroll: true,         // 自动滚动加载更多
    maxScrollTimes: 10,       // 最多滚动次数
    delayBetweenActions: 1500, // 操作间隔（毫秒，防风控）
    // 关键词加权打分（非硬性，总分 ≥ bonusThreshold 才收藏；0 = 跳过此关卡）
    // 每个技能项：{ name: 主名称, aliases: [别名…], weight: 权重 }
    // aliases 非空时只用别名匹配（避免 name 重复计分），为空时只用 name 匹配
    bonusKeywords: [],
    bonusKeywordsEnabled: true, // 关键词打分开关
    bonusThreshold: 5         // 关键词总分阈值
  };

  // 筛选运行时状态
  let scoutCfg = load(K.scoutCfg, SCOUT_DEFAULTS);
  scoutCfg = Object.assign({}, SCOUT_DEFAULTS, scoutCfg || {});
  let scoutProgress = load(K.scoutProgress, { favorited: [], skipped: [], running: false, paused: false, currentIndex: 0, currentJobId: '' });
  let scoutReport = load(K.scoutReport, []);

  function saveScoutCfg() { save(K.scoutCfg, scoutCfg); }
  function saveScoutProgress() { save(K.scoutProgress, scoutProgress); }
  function saveScoutReport() { save(K.scoutReport, scoutReport); }

  /* ---------------- 筛选核心逻辑 ---------------- */

  // 从卡片文本中解析实习时长（月）
  function parseDuration(text) {
    const m = /(\d+)\s*个月/.exec(text || '');
    return m ? parseInt(m[1], 10) : -1;
  }

  // 从薪资文本中解析日薪中值
  function parseDailySalary(salary) {
    if (!salary) return 0;
    const m = /(\d+)\s*[-~—]\s*(\d+)/.exec(salary);
    if (!m) return 0;
    const low = parseInt(m[1], 10), high = parseInt(m[2], 10);
    return Math.floor((low + high) / 2);
  }

  // 从卡片文本中解析每周出勤天数
  function parseDaysPerWeek(text) {
    const m = /(\d+)\s*天\s*[\/每]/.exec(text || '');
    return m ? parseInt(m[1], 10) : 7;  // 没找到就假设 7 天（最严格）
  }

  // 判断招聘者状态是否合格
  function isRecruiterActive(text) {
    const t = text || '';
    // 硬性合格
    for (const s of scoutCfg.recruiterStatus) {
      if (t.includes(s)) return { ok: true, level: 'hard', status: s };
    }
    // 软性合格（需标注）
    for (const s of scoutCfg.recruiterStatusSoft) {
      if (t.includes(s)) return { ok: true, level: 'soft', status: s };
    }
    return { ok: false, level: 'none', status: '离线/未活跃' };
  }

  // 关键词加权打分（非硬性，返回总分和明细）
  // 每个技能项：主名称 + 别名都是匹配词，命中任意一个即得分
  // 单项得分 = weight（固定权重，不累加，每组最多得一次分）
  function calcBonusScore(jdText) {
    const keywords = scoutCfg.bonusKeywords || [];
    const threshold = Number(scoutCfg.bonusThreshold) || 0;
    const jd = (jdText || '').toLowerCase();
    let totalScore = 0;
    const details = [];

    for (const item of keywords) {
      const name = item.name || '';
      const aliases = Array.isArray(item.aliases) ? item.aliases.filter(Boolean) : [];
      const weight = Math.max(0, Number(item.weight) || 1);
      // 匹配词列表：主名称 + 所有别名
      const matchWords = [name, ...aliases].filter(Boolean);
      let hitWord = null;

      for (const word of matchWords) {
        const w = word.toLowerCase();
        if (!w) continue;
        if (jd.includes(w)) { hitWord = word; break; }
      }

      if (hitWord) {
        totalScore += weight;
        details.push({ name: name, matchedWord: hitWord, weight: weight, points: weight });
      }
    }

    return { score: totalScore, threshold: threshold, details: details, pass: threshold <= 0 || totalScore >= threshold };
  }

  // 检查硬伤（命中任一直接跳过）
  function checkHardInjuries(text) {
    const t = text || '';
    const hits = [];
    for (const inj of scoutCfg.hardInjuries) {
      if (t.includes(inj)) hits.push(inj);
    }
    return { pass: hits.length === 0, hits };
  }

  // 第一阶段判定：卡片文本初筛（时长、日薪、出勤）
  // 返回 { pass: bool, reasons: string[], data: {...} }
  function judgeJobCard(cardText, salary) {
    const reasons = [];
    const data = {};

    // 1. 时长
    const months = parseDuration(cardText);
    data.months = months;
    if (months < 0) { reasons.push('时长未识别'); }
    else if (months > scoutCfg.maxMonths) { return { pass: false, reasons: ['时长 ' + months + ' 个月 > ' + scoutCfg.maxMonths], data }; }
    else { reasons.push('时长 ' + months + ' 月 ✓'); }

    // 2. 日薪
    const dailySalary = parseDailySalary(salary);
    data.dailySalary = dailySalary;
    if (dailySalary < scoutCfg.minDailySalary) { return { pass: false, reasons: ['日薪中值 ' + dailySalary + ' < ' + scoutCfg.minDailySalary], data }; }
    else { reasons.push('日薪中值 ' + dailySalary + ' ✓'); }

    // 3. 出勤
    const days = parseDaysPerWeek(cardText);
    data.daysPerWeek = days;
    if (days > scoutCfg.maxDaysPerWeek) { return { pass: false, reasons: ['出勤 ' + days + ' 天/周 > ' + scoutCfg.maxDaysPerWeek], data }; }
    else { reasons.push('出勤 ' + days + ' 天/周 ✓'); }

    return { pass: true, reasons, data };
  }

  // 生成横线分隔式日志（方案A emoji + 时间戳）
  function formatJobCard(title, company, salary, recruiterStatus, checks, resultLine) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const sep = '─'.repeat(40);

    const lines = [];
    lines.push('[' + ts + '] ' + sep);
    lines.push('[' + ts + '] 📋 ' + title + (company ? ' | ' + company : ''));
    lines.push('[' + ts + '] 💰 ' + salary + '元/天 | 👤 ' + (recruiterStatus || '未知'));
    lines.push('[' + ts + '] ' + checks.map((c) => (c.pass ? '✅' : '❌') + ' ' + c.label).join(' | '));
    if (resultLine) {
      lines.push('[' + ts + '] ' + resultLine);
    }
    lines.push('[' + ts + '] ' + sep);
    return lines.join('\n');
  }

  // 从详情面板读取招聘者状态
  function readRecruiterStatusFromDetail(detailPanel) {
    const allStatuses = ['在线', '刚刚活跃', '今日活跃', '昨日活跃', '3日内活跃', '本周活跃'];
    
    // 策略1：尝试定位 HR 信息条（岗位介绍下方、公司信息上方的区域）
    // BOSS直聘的HR信息通常在特定的容器中
    const hrInfoSelectors = [
      '.recruiter-info',
      '.hr-info', 
      '.boss-info',
      '.job-boss',
      '.recruiter',
      '.boss-card',
      '.job-detail .info',
      '.detail-content .recruiter',
      '[class*="recruiter"]',
      '[class*="boss"]'
    ];
    
    for (const selector of hrInfoSelectors) {
      const hrElement = detailPanel ? detailPanel.querySelector(selector) : document.querySelector(selector);
      if (hrElement) {
        const hrText = (hrElement.innerText || '').replace(/\s+/g, ' ').trim();
        log('[HR状态] 找到HR信息条 (' + selector + '): ' + hrText.substring(0, 200));
        
        for (const status of allStatuses) {
          if (hrText.includes(status)) {
            log('[HR状态] 从HR信息条匹配到: ' + status);
            return status;
          }
        }
      }
    }
    
    // 策略2：在整个详情面板中搜索
    if (detailPanel) {
      const panelText = (detailPanel.innerText || '').replace(/\s+/g, ' ').trim();
      log('[HR状态] 详情面板文本片段: ' + panelText.substring(0, 500));
      
      for (const status of allStatuses) {
        if (panelText.includes(status)) {
          log('[HR状态] 从详情面板匹配到: ' + status);
          return status;
        }
      }
    }
    
    // 策略3：在整个页面中搜索（但要排除列表页的干扰，只搜索右侧详情区域）
    log('[HR状态] 尝试在页面右侧区域搜索...');
    const rightPanel = document.querySelector('.job-detail-wrap') || 
                       document.querySelector('.right-panel') ||
                       document.querySelector('.side-panel') ||
                       document.body;
    const rightText = (rightPanel.innerText || '').replace(/\s+/g, ' ').trim();
    
    for (const status of allStatuses) {
      if (rightText.includes(status)) {
        log('[HR状态] 从右侧面板匹配到: ' + status);
        return status;
      }
    }
    
    // 策略4：搜索包含状态关键词的特定元素（如span、div、badge等）
    log('[HR状态] 尝试搜索状态标签元素...');
    const statusElements = $$('span, div, em, i, label').filter((e) => {
      const t = (e.innerText || '').trim();
      return allStatuses.some((s) => t === s || t.includes(s));
    });
    
    if (statusElements.length > 0) {
      // 取第一个匹配的元素，优先取在详情面板内的
      const inDetail = statusElements.find((e) => detailPanel && detailPanel.contains(e));
      const target = inDetail || statusElements[0];
      const statusText = (target.innerText || '').trim();
      log('[HR状态] 从标签元素匹配到: ' + statusText);
      return statusText;
    }
    
    log('[HR状态] 未匹配到任何状态');
    return null;
  }

  // 在列表页点击岗位卡片打开详情页，然后在右侧详情面板里点击收藏按钮
  // 返回 { ok, why, recruiterStatus }
  async function clickFavoriteButton(cardElement) {
    if (!cardElement) return { ok: false, why: '没有卡片元素', recruiterStatus: null };
    
    // 检查是否已暂停/停止
    if (!scoutProgress.running || scoutProgress.paused) {
      return { ok: false, why: '筛选已暂停/停止', recruiterStatus: null };
    }
    
    // 1. 找到岗位链接并点击，打开右侧详情面板
    const jobLink = cardElement.querySelector('a[href*="job_detail"]') || 
                    cardElement.querySelector('a[href*="job/"]') ||
                    cardElement.closest('a[href*="job"]');
    
    if (!jobLink) {
      log('[收藏] 未找到岗位链接');
      return { ok: false, why: '没找到岗位链接', recruiterStatus: null };
    }
    
    log('[收藏] 点击岗位链接打开详情面板');
    jobLink.click();
    
    // 2. 等待详情面板加载（可中断）- 增加等待时间到3秒
    await sleepInterruptible(3000);
    if (!scoutProgress.running || scoutProgress.paused) {
      return { ok: false, why: '筛选已暂停/停止', recruiterStatus: null };
    }
    
    // 3. 在详情面板区域查找收藏按钮
    // BOSS直聘的详情面板通常在右侧，尝试更多选择器
    const detailPanel = document.querySelector('.job-detail-wrap') || 
                       document.querySelector('.job-detail') ||
                       document.querySelector('.detail-panel') ||
                       document.querySelector('.job-card-detail') ||
                       document.querySelector('[class*="detail"]') ||
                       document.querySelector('.right-panel') ||
                       document.querySelector('.side-panel');
    
    if (!detailPanel) {
      log('[收藏] 未找到详情面板容器，将在全页面搜索HR状态');
    } else {
      log('[收藏] 找到详情面板容器');
    }
    
    // 3.5 提取详情面板完整 JD 文本
    const detailText = detailPanel
      ? (detailPanel.innerText || '').replace(/\s+/g, ' ').trim()
      : '';
    log('[收藏] 详情面板文本长度: ' + detailText.length);
    if (detailText) log('[收藏] 详情面板文本片段: ' + detailText.substring(0, 300));

    // 3.6 读取招聘者状态（如果详情面板没找到，会在全页面搜索）
    const recruiterStatus = readRecruiterStatusFromDetail(detailPanel);
    log('[收藏] HR状态: ' + (recruiterStatus || '未知'));

    // 3.7 第二阶段检查：HR 活跃度
    const hrStatuses = scoutCfg.hrActiveStatus || [];
    if (recruiterStatus && hrStatuses.length > 0 && !hrStatuses.includes(recruiterStatus)) {
      log('[收藏] HR状态不符: ' + recruiterStatus + '，不在允许列表');
      return { ok: false, why: 'HR状态不符: ' + recruiterStatus, recruiterStatus, detailText };
    }

    // 3.8 第二阶段检查：硬伤关键词（开关开启时）
    if (scoutCfg.hardInjuriesEnabled !== false) {
      const hardInj = checkHardInjuries(detailText);
      if (!hardInj.pass) {
        log('[收藏] 硬伤关键词命中: ' + hardInj.hits.join(','));
        return { ok: false, why: '硬伤: ' + hardInj.hits.join(','), recruiterStatus, detailText };
      }
    }

    // 3.9 第二阶段检查：关键词加权打分（开关开启时）
    if (scoutCfg.bonusKeywordsEnabled !== false) {
      const bonus = calcBonusScore(detailText);
      const hasKeywords = (scoutCfg.bonusKeywords || []).length > 0;
      const thresholdActive = bonus.threshold > 0 && hasKeywords;
      if (thresholdActive) {
        if (!bonus.pass) {
          log('[收藏] 关键词得分不足: ' + bonus.score + ' < ' + bonus.threshold);
          return { ok: false, why: '关键词得分 ' + bonus.score + ' < 阈值 ' + bonus.threshold, recruiterStatus, detailText };
        }
        log('[收藏] 关键词得分: ' + bonus.score + ' ✓');
      }
    }

    // 4. 全部检查通过，在详情面板里查找收藏按钮
    let btns = [];
    if (detailPanel) {
      btns = $$('a, button, span, div', detailPanel).filter((e) => {
        const t = (e.innerText || '').trim();
        return visible(e) && !isUploadish(e) && (t === '收藏' || t === '感兴趣');
      });
    }
    
    if (!btns.length) {
      // 扩大搜索范围：在整个页面查找
      log('[收藏] 详情面板内未找到收藏按钮，扩大搜索范围');
      const allBtns = $$('a, button, span, div').filter((e) => {
        const t = (e.innerText || '').trim();
        return visible(e) && !isUploadish(e) && (t === '收藏' || t === '感兴趣');
      });
      if (!allBtns.length) {
        log('[收藏] 全页面未找到收藏按钮');
        return { ok: false, why: '没找到收藏按钮', recruiterStatus };
      }
      btns = allBtns;
    }
    
    // 5. 取最里层的元素（避免点到外层容器）
    const btn = btns.filter((e) => !btns.some((o) => o !== e && e.contains(o)))[0] || btns[0];
    const label = (btn.innerText || '').trim();
    
    log('[收藏] 找到按钮: ' + label);
    
    if (label.includes('取消')) {
      return { ok: false, why: '已经收藏过了（按钮文案是「' + label + '」）', recruiterStatus };
    }
    
    // 6. 点击收藏按钮
    try {
      btn.click();
      await sleepInterruptible(scoutCfg.delayBetweenActions);
      if (!scoutProgress.running || scoutProgress.paused) {
        return { ok: false, why: '筛选已暂停/停止', recruiterStatus };
      }
      
      // 7. 校验：按钮文案应该变成"取消收藏"或"已收藏"
      const newLabel = (btn.innerText || '').trim();
      log('[收藏] 点击后按钮文案: ' + newLabel);
      
      if (newLabel.includes('取消') || newLabel.includes('已')) {
        return { ok: true, why: '收藏成功', recruiterStatus };
      }
      
      // 再次检查是否有其他反馈
      await sleepInterruptible(500);
      if (!scoutProgress.running || scoutProgress.paused) {
        return { ok: false, why: '筛选已暂停/停止', recruiterStatus };
      }
      const finalCheck = detailPanel ? $$('a, button, span, div', detailPanel).some((e) => {
        const t = (e.innerText || '').trim();
        return t.includes('取消收藏') || t.includes('已收藏');
      }) : false;
      
      if (finalCheck) {
        return { ok: true, why: '收藏成功（通过二次检查确认）', recruiterStatus };
      }
      
      return { ok: false, why: '点击后按钮文案未变化（' + newLabel + '），可能没成功', recruiterStatus };
    } catch (e) {
      log('[收藏] 点击失败: ' + e.message);
      return { ok: false, why: '点击失败: ' + e.message, recruiterStatus };
    }
  }

  // 筛选主流程：在当前列表页筛选并收藏
  // 返回 { favorited: [...], skipped: [...], error: string|null }
  async function runScoutInCurrentPage(startIndex = 0) {
    const result = { favorited: [], skipped: [], error: null };
    const targetCount = scoutCfg.targetCount;
    const alreadyFavorited = (scoutProgress.favorited || []).slice();

    log('▶ 开始筛选：目标收藏 ' + targetCount + ' 个，已收藏 ' + alreadyFavorited.length + ' 个' + (startIndex > 0 ? '，从第 ' + (startIndex + 1) + ' 个岗位继续' : ''));

    // 检查是否在列表页
    if (!/\/web\/geek\/job|\/job_list|\/geek\/job/i.test(location.pathname + location.search)) {
      result.error = '当前不在岗位列表页，请先打开 BOSS 直聘的岗位搜索/列表页';
      log('✗ ' + result.error);
      return result;
    }

    // 如果已达到目标，提示用户但仍允许继续筛选
    if (alreadyFavorited.length >= targetCount) {
      log('· 已达到目标收藏数 ' + targetCount + '，将继续筛选更多岗位');
    }

    // 滚动加载
    let scrollCount = 0;
    const maxScrolls = scoutCfg.maxScrollTimes;

    // 持续筛选，直到用户暂停/停止或达到最大滚动次数
    while (scrollCount <= maxScrolls) {
      // 抓取当前页所有岗位卡片
      const links = $$('a').filter((a) => {
        if (!notMine(a) || !visible(a)) return false;
        const href = a.href || '';
        if (!/job_detail|jobDetail|\/job\//.test(href)) return false;
        const t = (a.innerText || '').trim();
        return t.length >= 2 && t.length <= 80;
      });

      if (!links.length) {
        log('· 本页没有找到岗位卡片');
        break;
      }

      log('· 本页识别到 ' + links.length + ' 个岗位卡片');

      // 逐个判定（从 startIndex 开始）
      for (let i = startIndex; i < links.length; i++) {
        const a = links[i];
        // 检查是否被停止或暂停
        if (!scoutProgress.running) {
          log('· 筛选已停止');
          return result;
        }
        if (scoutProgress.paused) {
          // 保存当前位置
          scoutProgress.currentIndex = i;
          scoutProgress.currentJobId = jobIdFromHref(a.href);
          saveScoutProgress();
          log('· 筛选已暂停，已记录位置：第 ' + (i + 1) + ' 个岗位');
          updateScoutLiveUI(); // 轻量更新，暂停按钮会由 renderScout() 重建
          return result;
        }

        const card = findCard(a);
        const cardText = (card.innerText || '').replace(/\s+/g, ' ').trim();
        const jobId = jobIdFromHref(a.href);
        const title = (a.innerText || a.getAttribute('title') || '').trim();
        // 提取公司名
        const compA = $$('a', card).find((x) => /company|gongsi/i.test(x.href || '') && x.innerText.trim().length > 1);
        const company = compA ? compA.innerText.replace(/\s+/g, ' ').trim() : '';

        // 检查是否已收藏（去重）
        if (alreadyFavorited.some((j) => j.id === jobId) || result.favorited.some((j) => j.id === jobId)) {
          // 跳过已收藏的，但仍需更新进度
          scoutProgress.currentIndex = i;
          scoutProgress.currentJobId = jobId;
          continue;
        }

        // 解析薪资（先解码 PUA 字符，再匹配）
        const decodedCardText = decodePUASalary(cardText);
        const domSalaryMatch = decodedCardText.match(SALARY_RE);
        const domSalary = domSalaryMatch ? domSalaryMatch[0] : '';
        log('[SalaryAPI] decoded: ' + decodedCardText.substring(0, 200));
        log('[SalaryAPI] domSalary: "' + domSalary + '"');
        const salary = getSalaryForJob(jobId, domSalary);

        // 如果使用了 API 缓存数据，记录日志
        if (salary !== domSalary && salaryCache.has(jobId)) {
          log('· 使用 API 薪资数据: ' + salary + ' (DOM: ' + domSalary + ')');
        }

        // 第一阶段：卡片文本初筛（时长、日薪、出勤）
        const verdict = judgeJobCard(cardText, salary);
        if (!verdict.pass) {
          result.skipped.push({ id: jobId, title, why: verdict.reasons.join('; ') });
          const checks = verdict.reasons.map((r) => ({ label: r, pass: r.includes('✓') }));
          log(formatJobCard(title, company, salary, '', checks, '❌ 跳过'));
          scoutProgress.currentIndex = i;
          scoutProgress.currentJobId = jobId;
          updateScoutLiveUI();
          await sleepInterruptible(scoutCfg.delayBetweenActions);
          if (!scoutProgress.running || scoutProgress.paused) {
            log('· 筛选已暂停/停止');
            return result;
          }
          continue;
        }

        // 第二阶段：打开详情面板，执行详情检查（HR→硬伤→关键词）并收藏
        const favResult = await clickFavoriteButton(card);
        const recruiterStatus = favResult.recruiterStatus;

        if (favResult.ok) {
          const jobInfo = {
            id: jobId,
            title: title,
            salary: salary,
            text: cardText.slice(0, 200),
            verdict: verdict.reasons.join('; '),
            recruiterStatus: recruiterStatus || '未知',
            ts: Date.now()
          };
          result.favorited.push(jobInfo);
          scoutProgress.favorited.push(jobInfo);
          const checks = [
            ...verdict.reasons.map((r) => ({ label: r, pass: true })),
            { label: '关键词通过', pass: true }
          ];
          log(formatJobCard(title, company, salary, recruiterStatus, checks, '⭐ 已收藏'));
          saveScoutProgress();
          saveScoutReport();

          // 检查是否已达到目标收藏数
          if (scoutProgress.favorited.length >= targetCount) {
            log('▶ 已达到目标收藏数 ' + targetCount + '，停止筛选');
            scoutProgress.currentIndex = i;
            scoutProgress.currentJobId = jobId;
            updateScoutLiveUI();
            return result;
          }
        } else {
          result.skipped.push({ id: jobId, title, why: favResult.why });
          const checks = [
            ...verdict.reasons.map((r) => ({ label: r, pass: true })),
            { label: favResult.why, pass: false }
          ];
          log(formatJobCard(title, company, salary, recruiterStatus, checks, '❌ 跳过'));
        }

        // 保存当前位置
        scoutProgress.currentIndex = i;
        scoutProgress.currentJobId = jobId;

        // 轻量级实时更新（不重建按钮，避免事件绑定丢失）
        updateScoutLiveUI();

        await sleepInterruptible(scoutCfg.delayBetweenActions);
        if (!scoutProgress.running || scoutProgress.paused) {
          log('· 筛选已暂停/停止');
          return result;
        }
      }

      // 重置 startIndex，因为翻页/滚动后是新内容
      startIndex = 0;

      // 尝试翻页或滚动
      if (scrollCount >= maxScrolls) {
        log('· 已达到最大滚动次数 ' + maxScrolls + '，停止');
        break;
      }

      // 先尝试点"下一页"
      const nextBtn = findNextButton();
      if (nextBtn && visible(nextBtn)) {
        log('· 翻到下一页');
        nextBtn.click();
        await sleepInterruptible(3000);  // 等页面加载
        if (!scoutProgress.running || scoutProgress.paused) {
          log('· 筛选已暂停/停止');
          return result;
        }
        scrollCount = 0;  // 翻页后重置滚动计数
        continue;
      }

      // 没有下一页，尝试滚动加载
      if (scoutCfg.autoScroll) {
        log('· 向下滚动加载更多（第 ' + (scrollCount + 1) + ' 次）');
        try {
          window.scrollTo(0, document.body.scrollHeight);
          document.documentElement.scrollTop = document.body.scrollHeight;
        } catch (e) {}
        await sleepInterruptible(2500);
        if (!scoutProgress.running || scoutProgress.paused) {
          log('· 筛选已暂停/停止');
          return result;
        }
        scrollCount++;
      } else {
        break;
      }
    }

    log('▶ 筛选结束：本轮收藏 ' + result.favorited.length + ' 个，跳过 ' + result.skipped.length + ' 个');
    return result;
  }

  // 从网页/文档里复制 API Base / Key 时，零宽空格、BOM、方向控制符、换行、制表符等都会一起被带进来。
  // 它们肉眼看不见，拼进 URL 后地址就不再以 http(s) 开头，xhr 会把它当成站内相对路径 —— POST 打到了
  // BOSS 自己的 nginx 上，回一个 405 的 HTML 页。所以存之前、用之前都彻底清一遍。
  // 清理范围：C0 控制字符（\x00-\x1F，含 \n \r \t）、DEL（\x7F）、C1 控制字符（\x80-\x9F）、
  // Unicode 零宽/格式符（\u200B-\u200F \u202A-\u202E \u2060 \uFEFF）、分隔符（\u2028 \u2029）
  function cleanCfgStr(v) {
    return String(v == null ? '' : v)
      .replace(/[\x00-\x1F\x7F-\x9F]/g, '')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u2028\u2029]/g, '')
      .trim();
  }
  function cleanApiBase(v) {
    return cleanCfgStr(v).replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  }

  let cfg = load(K.cfg, DEFAULTS);
  cfg = Object.assign({}, DEFAULTS, cfg || {});
  cfg.apiBase = cleanApiBase(cfg.apiBase) || DEFAULTS.apiBase;
  cfg.apiKey = cleanCfgStr(cfg.apiKey);
  cfg.model = cleanCfgStr(cfg.model) || DEFAULTS.model;
  // 迁移：老版本存过 jsdelivr（大陆不通），自动换成 npmmirror
  if (/jsdelivr|unpkg\.com/.test(cfg.pdfWorkerSrc || '')) cfg.pdfWorkerSrc = DEFAULTS.pdfWorkerSrc;
  // 并发生成数：老配置里没这个键时 Object.assign 已经填了默认值；这里再钳进 1..8，
  // 免得用户手输 99 之后一路 429 重试、日志刷成一片（上限是服务商侧的，不是本站的约束）。
  cfg.genConcurrency = Math.min(8, Math.max(1, Math.round(Number(cfg.genConcurrency) || DEFAULTS.genConcurrency)));
  // 多模型并行：如果 models 数组为空，用单 Key 配置自动补一条兜底，保证老用户升级不丢功能。
  if (!Array.isArray(cfg.models) || cfg.models.length === 0) {
    cfg.models = [{ apiBase: String(cfg.apiBase), apiKey: String(cfg.apiKey), model: String(cfg.model) }];
  }
  // 每个模型对象的字段也做防御性补齐（防止手动编辑存储时漏字段），顺手清掉不可见字符
  cfg.models.forEach((m, i) => {
    if (!m || typeof m !== 'object') m = cfg.models[i] = {};
    m.apiBase = cleanApiBase(m.apiBase) || cleanApiBase(cfg.apiBase);
    m.apiKey = cleanCfgStr(m.apiKey) || cfg.apiKey;
    m.model = cleanCfgStr(m.model) || cfg.model;
    m._label = '并行模型' + (i + 1);   // 内部标签，日志/探针用
  });

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
  function saveCfg() {
    save(K.cfg, cfg);
    // v0.5.7 fix：测试桩的 __store.cfg 只有部分字段，迁移时从 DEFAULTS 空字符串造出
    // cfg.models = [{ apiKey: '' }]。用户点「保存设置」后 saveCfg() 只存单 Key 字段，
    // 不重建 models → generateOne 拿到空 apiKey 直接抛错（ui-smoke 14 条全红）。
    // 补救：如果当前只有一个模型且它的 apiKey 为空，用最新单 Key 字段重建它。
    if (cfg.models.length === 1 && !cfg.models[0].apiKey && cfg.apiKey) {
      cfg.models = [{ apiBase: String(cfg.apiBase), apiKey: String(cfg.apiKey), model: String(cfg.model), _label: '并行模型1' }];
      save(K.cfg, cfg);  // 回写更新后的 models
    }
  }

  let jobs = load(K.jobs, []) || [];
  let details = load(K.details, {}) || {};
  let drafts = load(K.drafts, {}) || {};
  let stats = load(K.stats, { day: today(), sent: 0, generated: 0 }) || {};
  let pending = load(K.pending, []) || [];

  function today() { return new Date().toISOString().slice(0, 10); }
  function rollStats() {
    // 换日就把两个计数归零（today() 用的是 UTC，所以北京时间 08:00 翻）。旧写法把昨天的
    // sent/generated 原样搬进今天，等于「今日 20 条」的上限每天早上都少几条，非得你自己去
    // 日志页按一次「重置今日计数」才还得回来 —— 那是把 bug 做成了功能。
    if (stats.day !== today()) { stats = { day: today(), sent: 0, generated: 0 }; return; }
    if (stats.sent === undefined) stats.sent = 0;
    if (stats.generated === undefined) stats.generated = 0;
  }
  rollStats();

  /* ============ v0.5.4：一整块回写会把别的标签页踩掉（用户实测的那次「全变待处理」） ============
   * drafts / stats / jobs / details / pendingDetails 在存储里各是**一整块**，而每个标签页 boot
   * 时读走自己那份内存快照，之后所有改动都往整块上盖 —— 谁后写，谁就把别人在这期间新增的记录连锅端掉。
   *
   * 用户现场：他同时开着好几个 BOSS 标签页。批量在 A 页生成了 N 条草稿，他跳页面时接管的是**早就开着的
   * B 页**，B 内存里那份 drafts 是这些草稿生成之前的快照（近乎空的）。于是
   *   ① planLeft 读的是 B 的空快照 → 明明写好的那几条又算进「还剩 10/11 条」，再烧一遍 token；
   *   ② B 第一次 save(K.drafts, drafts) 把整块盖回去 → A 写好的草稿全没了 → 队列齐刷刷退回「待处理」。
   * 日志能接回，正因为 bgLogBuf 是另一个独立的键、只有这一处用途，谁也不会拿它去盖别的东西。
   *
   * 修法不是「写之前先刷一遍存储」：刷完到写完之间隔着一次大模型请求（5~15 秒），照样撞车。
   * 改成**每次只盖自己动过的那一条**（读最新整块 → 只改这一条 → 写回），并定期把存储里别人的
   * 新记录并回本页视图。今日计数同理 —— 那是发送上限的账，被旧快照盖掉等于上限形同虚设。
   */
  const genBusy = {};              // 这条岗位正在生成（声明提前了：下面 syncFromStorage 要认它）
  const sendBusy = {};             // 这条岗位正在发送（同上）

  function newerDraft(mine, theirs) {
    if (!mine) return theirs;
    if (!theirs) return mine;
    const a = Number(mine.ts || 0), b = Number(theirs.ts || 0);
    if (a !== b) return a > b ? mine : theirs;
    return mine.sent && !theirs.sent ? mine : theirs;   // 同一份草稿，「已发送」那条才是事实
  }

  // 只把这一页动过的 id 盖进存储最新那份；其余记录原样保留
  function saveDrafts(ids) {
    const st = load(K.drafts, {}) || {};
    const list = ids && ids.length ? ids : Object.keys(drafts);
    list.forEach((id) => { if (drafts[id]) st[id] = drafts[id]; else delete st[id]; });
    drafts = st;
    save(K.drafts, st);
  }

  // 「重置今日计数」的时间戳。为什么要有它：发送上限的账是 stats.sent，而上面那条规矩是「取两边的
  // 大值」—— 用户点到上限后去日志页按重置，只要另一个还开着的旧标签页随后回写一次，Math.max 就把
  // 刚清掉的 4/20 又抬回 4/20，重置等于没按（日志里让用户去按重置这句话，正是 v0.5.4 自己弄成空话的）。
  // 所以重置不只清数字，还盖一个时间戳；谁的快照比这次重置旧，谁的 sent 就不作数。
  function saveStats() {
    const st = load(K.stats, null);
    if (st && st.day) {
      if (String(st.day) > String(stats.day)) { stats = st; return; }   // 别的页面已经跨到今天，以它为准
      if (st.day === stats.day) {
        if (Number(st.resetAt || 0) > Number(stats.resetAt || 0)) {
          // 存储里那次重置比这一页知道的都新：sent 跟存储走（上限真的清了）；
          // generated 只是「今日已生成 N 条」的显示、不卡任何东西，仍按往上走，别把本页刚生成的丢掉。
          stats = { day: st.day, sent: Number(st.sent) || 0, generated: Math.max(Number(stats.generated) || 0, Number(st.generated) || 0), resetAt: st.resetAt };
        } else {
          // 计数只会往上走：两个标签页各发一条，取大的那个才是真数
          stats.sent = Math.max(Number(stats.sent) || 0, Number(st.sent) || 0);
          stats.generated = Math.max(Number(stats.generated) || 0, Number(st.generated) || 0);
        }
      }
    }
    save(K.stats, stats);
  }

  function saveJobs() {
    const st = load(K.jobs, []) || [];
    const mine = {};
    jobs.forEach((j) => { if (j && j.id) mine[j.id] = j; });
    // 存储里有、这一页没见过的岗位不能因为这次回写就消失（那是别的标签页刚抓回来的）；
    // 两边都有的以这一页为准（勾选、薪资这些就是这一页刚读过的）。两个标签页同时改同一条
    // 勾选时谁后写谁说了算 —— 真机上会这样，代价记在 README 的「已知限制」里。
    const merged = st.map((j) => (j && j.id && mine[j.id]) ? mine[j.id] : j);
    jobs.forEach((j) => { if (j && j.id && !st.some((x) => x && x.id === j.id)) merged.push(j); });
    jobs = merged;
    save(K.jobs, jobs);
  }

  // details（JD 库）也是整块，而且这里撞得更频繁：面板一次开 4 个后台标签抓详情，它们各自在
  // 加载那一刻读到同一份空快照，谁后写完就把别人刚抓回来的 JD 盖掉 —— 表现是「抓了 4 条、
  // 详情只涨 1 条」，剩下 3 条下一轮还得再开一遍标签（用户截图里「详情 12 / 岗位 19」有它一份）。
  function saveDetails() {
    const st = load(K.details, {}) || {};
    Object.keys(details).forEach((k) => {
      const mine = details[k];
      if (mine && (!st[k] || Number(mine.ts || 0) >= Number(st[k].ts || 0))) st[k] = mine;
    });
    details = st;
    save(K.details, st);
  }

  // pendingDetails（待抓详情的岗位清单）同一时刻有好几个人在写：面板一条条排，详情页一进去就销
  // 自己那条。整块盖回去会出两种坏事：① 面板刚排进去的那条被别的标签盖没 → 那个详情页打开后
  // 认不出自己该抓哪条，JD 永远缺；② 别的标签刚销掉的那条被复活 → 你以后自己点开那个岗位页，
  // 脚本当成「还没抓」冲进去抓一遍 JD、还顺手把你的标签关掉。所以写它只有两个入口：
  // 排（读回来、只补本页新排的那几条）和销（读回来、只摘自己这一条）。
  function addPending(items) {
    const st = load(K.pending, []) || [];
    (items || []).forEach((p) => {
      if (p && p.id && !st.some((x) => x && x.id === p.id)) st.push(p);
    });
    pending = st;
    save(K.pending, st);
  }
  function consumePending(hit) {
    const key = hit && (hit.id || hit.url);
    if (!key) return;
    pending = (load(K.pending, []) || []).filter((p) => p && (p.id || p.url) !== key);
    save(K.pending, pending);
  }

  // 定时把存储里别的标签页写的新记录并回本页视图（长命页面不然永远看着自己那份旧快照）
  function syncFromStorage() {
    let changed = false;
    const st = load(K.drafts, {}) || {};
    const merged = {};
    Object.keys(st).forEach((id) => {
      const mine = drafts[id];
      merged[id] = (genBusy[id] || sendBusy[id]) ? (mine || st[id]) : newerDraft(mine, st[id]);
    });
    Object.keys(drafts).forEach((id) => {
      if (id in st) return;
      // 存储里没有这一条 = 别的页面把它丢了（取消勾选/清空），或者本页刚写还没落盘。
      // 正在生成/发送的那条留着，其余跟着存储走 —— 否则旧页面会一直守着已丢弃的草稿。
      if (genBusy[id] || sendBusy[id]) merged[id] = drafts[id];
      else changed = true;
    });
    // 值签名只挑队列真正显示的那两件事（有几条草稿、其中几条已发送）：整块 deep-compare 每 3 秒
    // 跑一次太浪费，而只比键集合会漏掉「别处把某条从待发送变成已发送」这种要重画的情况。
    const sig = (o) => Object.keys(o).length + ':' + Object.keys(o).filter((k) => o[k] && o[k].sent).length;
    changed = changed || sig(merged) !== sig(drafts);
    drafts = merged;
    // 先按日子归零（这一页可能从昨晚一直开到今天下午，内存里还挂着昨天的账），再跟存储并
    const dayBefore = stats.day;
    rollStats();
    if (dayBefore !== stats.day) changed = true;
    const ss = load(K.stats, null);
    // 三种情况要跟存储走：它已经跨到今天、它那边刚按过重置（resetAt 更新鲜）、它记的发送数比本页多。
    // 第二条必须有，否则别的页面重置完，这一页内存里还是 4/20，会自己对自己喊「触达今日发送上限，停止」。
    if (ss && ss.day && (String(ss.day) > String(stats.day) ||
      (ss.day === stats.day && Number(ss.resetAt || 0) > Number(stats.resetAt || 0)) ||
      (ss.day === stats.day && Number(ss.sent) > Number(stats.sent)))) { stats = ss; changed = true; }
    const sj = load(K.jobs, []) || [];
    const byId = {};
    jobs.forEach((j) => { if (j && j.id) byId[j.id] = j; });
    sj.forEach((j) => {
      if (!j || !j.id) return;
      const m = byId[j.id];
      if (!m) { jobs.push(j); byId[j.id] = j; changed = true; return; }
    });
    return changed;
  }

  /* ---------------------------------------------------------------- 小工具 */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  
  // 可中断的睡眠：每 100ms 检查一次暂停/停止标志
  const sleepInterruptible = (ms) => new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (!scoutProgress.running || scoutProgress.paused) {
        resolve();
        return;
      }
      if (Date.now() - start >= ms) {
        resolve();
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
  
  const rnd = (a, b) => Math.floor(a + Math.random() * (b - a));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clamp = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n) : s; };
  const uid = () => Math.random().toString(36).slice(2, 8);

  // 日志必须常驻内存：切标签时 #bgLog 文本框会被重建，只往 DOM 里写会丢历史
  const logBuf = [];
  // 但光有内存还不够：整页跳转会把这个 JS 上下文连同 logBuf 一起销毁（用户实测：批量跑到一半
  // 点了别的页面，回来日志空了、任务也停了）。所以每行日志另外在油猴存储里留一份副本，
  // 新页面起来先把它捞回去 —— 存储只留最近 200 行，别把 GM 存储撑大。
  let logSavedAt = 0;
  let logFlush = 0;
  function saveLog(force) {
    const now = Date.now();
    if (!force && now - logSavedAt < 1200) {
      // 被节流挡掉的那几行也要落盘：整页跳转不等人，晚 1 秒写就是丢 1 秒的日志
      if (!logFlush) logFlush = setTimeout(() => { logFlush = 0; saveLog(true); }, 1300);
      return;
    }
    logSavedAt = now;
    // 生成器那一页写的日志单独存一份：两边各写各的，谁都不会把对方那 200 行盖掉
    // （旧写法是两边共用一个键、整块盖，结果是面板刷新生成的时候正好把生成器的进度抹了）。
    try { GM_setValue(isExec ? K.execLog : K.logbuf, logBuf.slice(-200)); } catch (e) {}
  }
  function restoreLog() {
    let prev = [];
    try { prev = GM_getValue(isExec ? K.execLog : K.logbuf, []) || []; } catch (e) { prev = []; }
    if (!Array.isArray(prev) || !prev.length) return 0;
    for (let i = Math.max(0, prev.length - 200); i < prev.length; i++) logBuf.push(prev[i]);
    return prev.length;
  }
  function log(msg) {
    logBuf.push('[' + new Date().toTimeString().slice(0, 8) + '] ' + msg);
    if (logBuf.length > 400) logBuf.shift();
    // 那两个 id 是面板的，生成器那一页不建面板，就不许往「别人那一页的」textarea 里写：
    // 同一份文档里跑两份脚本时（多标签模拟 / 站点重复注入），它会把观众页的日志整块盖掉。
    if (!isExec) {
      const box = document.getElementById('bgLog');
      if (box) { box.value = logBuf.join('\n'); box.scrollTop = box.scrollHeight; }
      const foot = document.getElementById('bgFoot');
      if (foot) foot.textContent = logBuf[logBuf.length - 1] || '';
    }
    saveLog(false);
    console.log('[BOSS打招呼] ' + msg);
  }

  // 页面一起来先把上一页留下的日志捞回来：整页跳转销毁内存，但油猴存储里那份还在
  const restoredLogs = restoreLog();

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

  // 收藏/感兴趣列表的标题常写成「28届后端实习生-示例短视频 [ 上海·浦东新区 ]」。括号那截是地点：
  // 混进标题既污染给大模型的提示词，又会让沟通页的职位名比对失败（沟通页只渲染纯标题），
  // 实测用户日志里那句「沟通页认不出当前会话是这个岗位」就是这么来的。
  const LOC_TAIL = /\s*[[（(【]\s*([^()（）[\]【】]{2,40}?)\s*[\]）)】]\s*$/;
  function splitTitleLoc(t) {
    const s = String(t || '').trim();
    const m = s.match(LOC_TAIL);
    if (!m) return { title: s, loc: '' };
    const inner = m[1];
    // 方括号是 BOSS 放地点的写法（[ 上海·浦东新区 ]），圆括号多半是限定语（（实习）），
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
    // 「实习-示例短视频」这种假城市（两段汉字中间一个连字符就算命中了）
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

  // 收藏/感兴趣页的主列卡片都在 .job-list-box 里；右侧「谁看过我 / 对我感兴趣的」是独立模块，
  // 里面的岗位同样是 a[href*=job_detail]，旧版整页扫描会把它们一起抓进来（用户截图里打叉的那几条）。
  // 先认主列表容器；认不出来时再用「侧栏标题」和「卡片宽度」两道过滤兜底，宁可少抓也不乱抓。
  const JOB_HREF_RE = /job_detail|jobDetail|\/job\//;
  const JOB_LIST_SCOPE_SELS = [
    ['.job-list-box', '[class*="job-list-box"]'],
    ['[class*="job-list-container"]', '[class*="job-list-wrap"]'],
    ['[class*="job-list"]']
  ];
  const SIDE_HEAD_RE = /^(谁看过我|对我感兴趣的)$/;

  function isJobHref(href) { return JOB_HREF_RE.test(String(href || '')); }

  // 从标题往上找到第一个装着岗位链接的窄容器：右侧两个推荐模块都是这个形状。
  // 只收窄的（< 55% 视口宽），防止把标题所在的整页大容器误判成侧栏。
  function sidebarRoots() {
    const out = [];
    const heads = $$('h1, h2, h3, h4, h5, strong, span, div, p')
      .filter((e) => {
        const t = (e.innerText || '').trim();
        return t.length >= 4 && t.length <= 12 && SIDE_HEAD_RE.test(t) && visible(e) && notMine(e);
      });
    heads.forEach((h) => {
      let cur = h;
      for (let i = 0; i < 8 && cur.parentElement; i++) {
        cur = cur.parentElement;
        if (!$$('a', cur).some((a) => isJobHref(a.href))) continue;
        if (cur.getBoundingClientRect().width < window.innerWidth * 0.55 &&
            !out.some((r) => r === cur || r.contains(cur))) out.push(cur);
        break;
      }
    });
    return out;
  }

  // 主列表容器：按精确度分三档找，找到哪一档就只用哪一档的链接。
  // 宽度 < 45% 视口的不算主列（右侧推荐模块即使 class 里带 job-list 也不会被当成主列表）。
  function mainListRoots(sideRoots) {
    for (const sels of JOB_LIST_SCOPE_SELS) {
      const out = [];
      sels.forEach((sel) => {
        $$(sel).forEach((root) => {
          if (!visible(root)) return;
          if (root.getBoundingClientRect().width < Math.min(420, window.innerWidth * 0.45)) return;
          if (sideRoots.some((s) => s.contains(root))) return;
          if (!$$('a', root).some((a) => isJobHref(a.href) && visible(a) && notMine(a))) return;
          if (!out.some((r) => r === root || r.contains(root))) out.push(root);
        });
      });
      if (out.length) return out;
    }
    return [];
  }

  function jobLinksIn(roots) {
    const out = [];
    roots.forEach((root) => { $$('a', root).forEach((a) => { if (isJobHref(a.href)) out.push(a); }); });
    return out;
  }

  function scrapeCurrentPage(silent) {
    const seen = {};
    const found = [];
    const side = sidebarRoots();
    const roots = mainListRoots(side);
    // 认得出主列表就只扫主列表；认不出才退回整页，但下面会按侧栏标题和卡片宽度再筛。
    let links = roots.length ? jobLinksIn(roots) : $$('a').filter((a) => isJobHref(a.href));
    links = links.filter((a) => {
      if (!notMine(a) || !visible(a)) return false;
      if (!isJobHref(a.href)) return false;
      if (side.some((r) => r.contains(a))) return false;
      const t = (a.innerText || '').trim();
      return t.length >= 2 && t.length <= 80;
    });
    // 没认出主列表容器时的兜底：侧栏卡片窄得多，主列卡片宽。
    // 以本页最宽卡片的 55% 为界，同时不低于 320px；正常窗口里主列一定过线。
    let droppedNarrow = 0;
    if (!roots.length && links.length) {
      const widths = links.map((a) => {
        try { return findCard(a).getBoundingClientRect().width; } catch (e) { return 0; }
      });
      const maxW = Math.max.apply(null, widths.concat([0]));
      const minW = Math.max(320, maxW * 0.55);
      links = links.filter((a, i) => {
        const keep = widths[i] >= minW;
        if (!keep) droppedNarrow++;
        return keep;
      });
    }
    links.forEach((a) => {
      const id = jobIdFromHref(a.href);
      if (!id || seen[id]) return;
      seen[id] = 1;
      try { found.push(parseJobCard(a)); } catch (e) { /* 跳过脏节点 */ }
    });
    if (!silent && (side.length || droppedNarrow)) {
      log('· 本页只取职位收藏主列表' + (roots.length ? '' : '（没认出主列表容器，按侧栏标题/卡片宽度过滤）') +
        (droppedNarrow ? '，排除 ' + droppedNarrow + ' 个侧栏窄卡片' : '') +
        (side.length ? '，已忽略「谁看过我 / 对我感兴趣的」侧栏' : ''));
    }
    let added = 0;
    // 记下「这张卡片是在哪个列表页看到的」：发送时可以直接在那个列表页上点卡片自己的沟通按钮
    // （见 sendViaListTab），不必再开一次详情页。翻页时 URL 不变，所以同一 URL 下滚动能找到就行。
    const pageUrl = location.href.split('#')[0];
    found.forEach((j) => {
      j.listUrl = pageUrl;
      const exist = jobs.findIndex((x) => x.id === j.id);
      if (exist >= 0) { jobs[exist] = Object.assign(jobs[exist], j); }   // 保留已有的 sel，别把用户的取消勾选冲掉
      // v0.5.1：新抓到的岗位默认**不**进队列。收藏列表里往往躺着几十条早就没兴趣的岗位，
      // 一抓就全塞进队列，等于逼着脚本给每一条都开一个后台标签抓 JD（慢、吃限流），
      // 也逼着用户去队列里一条条取消。现在改成「抓回来只是入库，勾上才算要处理」，
      // 详情抓取跟着勾选走（见 planDetails）。
      else { j.sel = false; jobs.push(j); added++; }
    });
    saveJobs();
    pruneDrafts();
    if (!silent) log('本页识别到 ' + found.length + ' 个岗位，新增 ' + added + ' 个（累计 ' + jobs.length + '）；' +
      '新岗位默认未勾选 —— 去「岗位」页勾上才进队列，勾上时缺 JD 的会自动去后台抓');
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
    // 先读回来再认：这一页 boot 那一刻的快照可能已经少了面板刚排进去的那条
    pending = load(K.pending, []) || [];
    const hit = pending.find((p) => normalizeUrl(p.url) === cur);
    if (hit) consumePending(hit);
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
    // 标题取 document.title 的「最后一段站点后缀」，不是第一个连字符：
    // 真实详情页是「28届后端实习生-示例短视频 _ 上海 200-250元/天 - BOSS直聘」，
    // 岗位名自己就带连字符，按第一个 - 切会把标题腰斩成「28届后端实习生」。
    details[id] = { id: id, text: clamp(text, 5000), title: document.title.replace(/\s+[-|]\s+[^-|]*$/, '').trim(), ts: Date.now() };
    saveDetails();
    return text.length;
  }

  // selected() 给的是岗位对象，不是 id。以前直接把对象塞进来，于是
  // jobs.find(j => j.id === 对象) 永远找不到 → 每个岗位都 continue →
  // 日志打着「打开 4 个后台标签抓详情」，实际一个标签都没开，进度永远 0/4。
  // 「抓选中岗位详情」点了没反应、详情一直是 0，就是这里。
  function toIds(list) {
    return (list || []).map((x) => (typeof x === 'string' ? x : x && x.id)).filter(Boolean);
  }

  // 面板这边判断「这条岗位有没有 JD」只认正文，不看 title 之类的边脚料。
  function hasDetail(id) {
    const d = details[id];
    return !!(d && d.text);
  }

  // 后台标签抓到 JD 只会写油猴存储，面板得自己并回来。规则：缺的补上，时间戳更新的覆盖。
  // 只补不覆盖的话，重新抓一遍 JD（岗位描述改了/第一次抓到的是半页）永远不会生效，
  // 面板会一直卡在第一次那份上，草稿指纹也跟着不会变。
  function refreshDetails() {
    const d = load(K.details, {}) || {};
    let changed = false;
    Object.keys(d).forEach((k) => {
      const cur = details[k];
      if (!cur || (d[k].ts || 0) > (cur.ts || 0)) { details[k] = d[k]; changed = true; }
    });
    if (changed) saveDetails();
    return changed;
  }

  async function fetchDetails(list) {
    const ids = toIds(list);
    if (!ids.length) { log('队列里没有岗位'); return; }
    refreshDetails();
    const todo = ids.filter((id) => !hasDetail(id));
    if (!todo.length) { log('这 ' + ids.length + ' 个岗位的 JD 都已经在库里，不用重开标签'); return; }
    const openable = [];
    const dead = [];
    todo.forEach((id) => {
      const job = jobs.find((j) => j.id === id);
      if (job && /^https?:/.test(job.url || '')) openable.push(id); else dead.push(id);
    });
    // 列表里没抓到链接的岗位（站点改版/卡片结构变了）：连详情页都打不开，JD 无从谈起，
    // 与其默默跳过不如点名说清——没 JD 是不会生成招呼语的。
    if (dead.length) log('· ' + dead.length + ' 个岗位没抓到详情页链接，拿不到 JD，不会生成：' + dead.map(jobTitle).join('、'));
    if (!openable.length) return;
    // 数量只认真正要开出去的这批。旧版先打「打开 4 个后台标签」再在循环里逐个 continue，
    // 结果日志吹的数和实际开出去的数对不上，用户只能对着日志猜。
    log('打开 ' + openable.length + ' 个后台标签抓详情（期间别关这些标签）');
    for (const id of openable) {
      const job = jobs.find((j) => j.id === id);
      addPending([{ url: job.url, id: id, ts: Date.now() }]);
      GM_openInTab(job.url, { active: false, insert: true, setParent: true });
      await sleep(rnd(2200, 4200));
    }
    // 轮询等待回收
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      await sleep(1200);
      refreshDetails();
      const done = openable.filter((i) => hasDetail(i)).length;
      log('详情回收进度 ' + done + '/' + openable.length);
      if (done >= openable.length) break;
    }
    renderJobs();
    const miss = openable.filter((i) => !hasDetail(i));
    log(miss.length
      ? '详情抓取结束，还差 ' + miss.length + ' 个没抓到（这些不会生成招呼语）：' + miss.map(jobTitle).join('、')
      : '详情抓取结束');
  }

  // 抓完列表顺手把 JD 也拿回来：详情页就是卡片标题那个链接（job.url），
  // 后台开标签进去抓就行。列表卡片上那两颗「继续沟通/立即沟通」不是详情入口，
  // 它们打的是 friend/add，点下去直接进沟通页、还把话发给对应 HR —— 抓个详情
  // 犯不着冒这个险，所以这里一颗按钮都不点。
  async function autoDetailsAfterScrape() {
    if (!cfg.autoFetchDetail) { log('· 「勾选岗位自动抓详情」是关的；没有 JD 的岗位不会生成招呼语，需要 JD 请点「抓选中岗位详情」或用队列里的「补抓详情并生成」'); return; }
    refreshDetails();
    const sel = toIds(selected());
    const ids = sel.filter((id) => !hasDetail(id));
    if (ids.length) { await fetchDetails(ids); return; }
    log(sel.length ? '选中的岗位都已有详情，不用重开标签'
      : '队列里还没有岗位（新抓到的默认不勾选）—— 去「岗位」页勾上，勾上时缺 JD 的会自动抓');
  }

  /* ---------------- 勾选 = 进队列 = 需要 JD：详情抓取跟着勾选走 -------------
   * 用户是「一条一条勾」的，每勾一条就开一个后台标签太吵（也容易被站点限流），
   * 所以这里只把缺 JD 的岗位攒进 detailPlan，等手停下来（防抖 1.5s）再一次性开标签。
   * fetchDetails 自己会跑一分多钟，期间又勾了新岗位：那些留在 want 里，
   * 这一批跑完再起一批，绝不并发跑两批（busy 挡着）。
   * cfg.autoFetchDetail 是这条自动路径的总开关，关着就只进队列、不动标签，
   * 用户想用「抓选中岗位详情」自己掌握节奏也可以。
   */
  const detailPlan = { want: [], timer: 0, busy: false };

  function planDetails(list) {
    if (!cfg.autoFetchDetail) return;
    refreshDetails();
    const add = toIds(list).filter((id) => {
      if (hasDetail(id)) return false;
      const job = jobs.find((j) => j.id === id) || {};
      return /^https?:/.test(job.url || '');   // 连详情页链接都没有：开了标签也抓不到，别白开
    });
    if (!add.length) return;
    add.forEach((id) => { if (detailPlan.want.indexOf(id) < 0) detailPlan.want.push(id); });
    log('· 已排进后台抓详情：' + add.map(jobTitle).join('、') + '（攒一批一起开标签）');
    clearTimeout(detailPlan.timer);
    detailPlan.timer = setTimeout(runPlannedDetails, 1500);
  }

  async function runPlannedDetails() {
    if (detailPlan.busy || !detailPlan.want.length) return;
    const ids = detailPlan.want.slice();
    detailPlan.want.length = 0;
    detailPlan.busy = true;
    try { await fetchDetails(ids); }
    finally {
      detailPlan.busy = false;
      if (detailPlan.want.length) { clearTimeout(detailPlan.timer); detailPlan.timer = setTimeout(runPlannedDetails, 1000); }
    }
  }

  /* ---------------------------------------------------------------- 大模型 */

  async function chat(systemText, userText, modelCfg, attempt) {
    attempt = attempt || 0;
    const mc = modelCfg || cfg;   // 兼容旧调用：不传 modelCfg 时用全局 cfg 兜底
    const apiKey = cleanCfgStr(mc.apiKey);
    if (!apiKey) throw new Error('未填写 API Key');
    const apiBase = cleanApiBase(mc.apiBase);
    if (!/^https?:\/\//i.test(apiBase)) {
      throw new Error('API Base 填得不对：必须以 http:// 或 https:// 开头（当前是 ' + JSON.stringify(String(mc.apiBase)) + '，可能混进了空格或不可见字符）');
    }
    const url = apiBase + '/chat/completions';
    const body = JSON.stringify({
      model: cleanCfgStr(mc.model),
      messages: [{ role: 'system', content: systemText }, { role: 'user', content: userText }],
      temperature: Number(cfg.temperature),
      max_tokens: Number(cfg.maxTokens),
      stream: false
    });
    let res;
    const t0 = Date.now();
    try {
      res = await gmXhr('POST', url, {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + mc.apiKey
      }, body, 120000);
    } catch (e) {
      llmMark(t0, mc._label);
      if (attempt < 2) { await sleep(2500 * (attempt + 1)); return chat(systemText, userText, mc, attempt + 1); }
      throw e;
    }
    llmMark(t0, mc._label);
    if (res.status === 429 || res.status >= 500) {
      // 抖动是并发生成之后必须加的：N 路同时被限流时，没有抖动它们会同一时刻重试、
      // 再次同时撞墙，退避就等于没退避。加 0~1.2s 随机偏移把重试错开。
      if (attempt < 3) {
        const w = 3000 * Math.pow(2, attempt) + Math.floor(Math.random() * 1200);
        log('[' + (mc._label || '?') + '] 模型限流/异常 ' + res.status + '，' + Math.round(w / 100) / 10 + 's 后重试（并发生成数调小可以避免）');
        await sleep(w); return chat(systemText, userText, mc, attempt + 1);
      }
    }
    let data = null;
    try { data = JSON.parse(res.responseText); } catch (e) { /* 非 JSON */ }
    if (res.status < 200 || res.status >= 300) {
      const hint = data && data.error ? (data.error.message || JSON.stringify(data.error)) : clamp(res.responseText, 200);
      // 把最终 POST 的地址写进报错：405/404 这类多半是 Base 拼错（少了 /v1、混进别家域名、
      // 或者地址粘进了不可见字符），不带上地址的话用户在日志里只能看到一串 nginx 的 HTML。
      const where = '（POST ' + url + (res.status === 405
        ? '，405 通常是 API Base 拼错了：确认地址以 /v1 这类版本段结尾，且没有把 /chat/completions 也填进去'
        : '') + '）';
      throw new Error('HTTP ' + res.status + ' ' + hint + where);
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
    // 只有旧版本留下的草稿在算指纹时会走到这一行：v0.4.2 起没有 JD 根本不给生成（见 generateOne），
    // 但指纹必须还能算出「当时那份提示词」，否则老草稿会被莫名其妙统统判过期。
    else if (job.text) parts.push('列表信息：\n' + clamp(job.text, 900));
    return parts.filter(Boolean).join('\n');
  }

  async function generateOne(id, modelCfg) {
    const job = jobs.find((j) => j.id === id);
    if (!job) throw new Error('岗位不存在');
    const resume = getResume();
    if (resume.length < 60) throw new Error('简历内容太少，先去「简历」页设置');
    // 硬拦：没抓到 JD 就不生成（用户定的策略）。只凭卡片上那行标题+薪资让大模型写招呼语，
    // 它只能编——句子通顺但和岗位的实际职责无关，发给 HR 反而掉好感，比不发更糟。
    // 这里必须在发请求之前抛错：请求一旦发出去，钱花了、草稿也标成「已生成」，拦都拦不住。
    refreshDetails();
    if (!hasDetail(id)) {
      // noJd 是给批量看的标记：批量据此把这条标成「缺 JD 已跳过」并且不等反爬间隔（压根没发请求）。
      const err = new Error(/^https?:/.test(job.url || '')
        ? '「' + jobTitle(id) + '」还没抓到岗位详情（JD），不给生成。点这条下面的「补抓详情并生成」，脚本会后台打开这个岗位的详情页把 JD 捞回来再写'
        : '「' + jobTitle(id) + '」没有详情页链接，抓不到 JD，不给生成（这条只能你自己进页面看岗位描述）');
      err.noJd = true;
      throw err;
    }
    const userText = cfg.userPrompt
      .replace('{{RESUME}}', clamp(resume, Number(cfg.resumeChars)))
      .replace('{{JOB}}', jobForPrompt(job));
    llmLive++;
    log('→ [' + (modelCfg._label || '?') + '] 发出模型请求「' + jobTitle(id) + '」（同时在飞 ' + llmLive + ' 条）');
    let txt;
    try { txt = await chat(cfg.systemPrompt, userText, modelCfg); }
    finally { llmLive--; }
    drafts[id] = { text: txt, ts: Date.now(), sent: false, fp: draftFp(id) };
    saveDrafts([id]);
    // 上一轮批量可能把这条标成「缺 JD 已跳过」，现在草稿都有了，那个徽章得摘掉，
    // 否则队列里会同时出现「已有草稿」和「缺 JD 已跳过」，用户不知道能不能发。
    delete states[id];
    stats.generated++;
    saveStats();
    renderQueue();
    return txt;
  }

  /* ------------------- 并发生成：同一条岗位只允许一路在飞 -------------------
   * generateOne 本身可以并发（JS 单线程，drafts/stats 的写都在 await 之外，一次写完），
   * 但「同一个 id 被两路同时生成」是真会浪费钱的：批量池正在写这条、用户又手点了这行的
   * 「生成并发送」，那就是两条大模型请求、两份草稿互相覆盖。所以按 id 合流：
   * 第二次点同一个 id 复用同一个 Promise，一次点击一次请求。
   */
  function generateShared(id, modelCfg) {
    if (genBusy[id]) return genBusy[id];
    const p = generateOne(id, modelCfg).then(
      (t) => { delete genBusy[id]; return t; },
      (e) => { delete genBusy[id]; throw e; }
    );
    genBusy[id] = p;
    return p;
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
    saveDrafts([id]);
    log('· ' + why + '：丢掉「' + jobTitle(id) + '」的未发送草稿，重新勾选后会按最新简历/详情重生成');
    return true;
  }

  function setSel(id, on) {
    const j = jobs.find((x) => x.id === id);
    if (!j) return;
    j.sel = !!on;
    saveJobs();
    if (!on) dropDraft(id, '取消勾选');
    else planDetails([id]);             // 勾上 = 要处理它：这条缺 JD 的话排进后台抓详情
    updateStat();
    renderQueue();                    // 不在队列页时它自己会 return，不会抢焦点
  }

  function setSelMany(ids, on) {
    let dropped = 0;
    const gone = [];
    ids.forEach((id) => {
      const j = jobs.find((x) => x.id === id);
      if (!j) return;
      j.sel = !!on;
        if (!on && drafts[id] && !drafts[id].sent) { delete drafts[id]; delete states[id]; gone.push(id); dropped++; }
    });
    saveJobs();
    if (gone.length) saveDrafts(gone);
    log((on ? '已全选 ' : '已取消全部 ') + ids.length + ' 个岗位' + (dropped ? '，连带丢掉 ' + dropped + ' 条未发送草稿' : ''));
    if (on) planDetails(ids);           // 全选也是一次性进队列：下面防抖会并成一批开标签
    updateStat();
    renderQueue();
  }

  // 岗位列表被清空/重抓后，草稿里那些已经找不到岗位的记录要一起清掉，否则会一直占着存储。
  // 它排在 saveJobs() 之后调用，这样判孤儿时看的 jobs 已经把存储那份并回来了（别的标签页刚抓
  // 回来的岗位不至于被判成孤儿）。这条顺序是省事，不是靠断言钉着的安全闸 —— 真正防串页覆盖
  // 的是 saveJobs/saveDrafts 那两处「先读最新整块、只改自己动过的那一条」。
  function pruneDrafts() {
    const alive = {};
    jobs.forEach((j) => { alive[j.id] = 1; });
    const gone = Object.keys(drafts).filter((id) => !alive[id]);
    Object.keys(states).forEach((id) => { if (!alive[id]) delete states[id]; });
    if (!gone.length) return 0;
    gone.forEach((id) => delete drafts[id]);
    saveDrafts(gone);
    log('清掉 ' + gone.length + ' 条孤儿草稿（对应岗位已不在列表里）');
    return gone.length;
  }

  /* -------------------------------------------------------------- 发送消息 */

  // 真实沟通页的输入框是 <div class="chat-input" contenteditable="true">（已在本机 Edge 的登录态下看过）。
  // 旧版在精确特征找不到时会退回「页面下半部分任何一个 textarea / contenteditable / input[type=text]」，
  // 结果在收藏列表页上把右侧「VIP 兑换码」那颗 <input> 当成了聊天框，把招呼语填了进去 ——
  // 用户看到的就是「随便找了个输入框就往里填字」，真正的列表卡片 → 沟通页路线反而没走。
  // 沟通框只可能是可编辑区域，而且一定长在聊天容器里；凡是普通 <input> 一律不认。
  const CHAT_INPUT_SELS = [
    'div.chat-input[contenteditable="true"]',
    'div.chat-input[contenteditable]',
    '[class*="chat-input"][contenteditable="true"]',
    '[class*="chat-input"][contenteditable]',
    '#chat-input[contenteditable]',
    'textarea[class*="chat-input"]'
  ];
  const CHAT_SCOPE_SELS = [
    '[class*="chat-conversation"]',
    '[class*="chat-im"]',
    '[class*="chat-editor"]',
    '[class*="editor-container"]',
    '[class*="message-controls"]',
    '[class*="chat-content"]'
  ].join(',');

  function isChatComposer(el) {
    if (!el || !el.getAttribute) return false;
    if (!notMine(el) || !visible(el) || isUploadish(el)) return false;
    const editable = el.tagName === 'TEXTAREA' ||
      el.isContentEditable ||
      (el.hasAttribute('contenteditable') && String(el.getAttribute('contenteditable')) !== 'false');
    if (!editable) return false;
    if (CHAT_INPUT_SELS.some((sel) => { try { return el.matches(sel); } catch (e) { return false; } })) return true;
    return !!el.closest(CHAT_SCOPE_SELS);
  }

  function findChatInput() {
    for (const sel of CHAT_INPUT_SELS) {
      const el = $$(sel).filter((e) => isChatComposer(e))[0];
      if (el) return el;
    }
    // 兜底也只在聊天容器里找可编辑区域：input 不认（站点上的搜索框、兑换码框都在这条线外）。
    const cand = $$('textarea, [contenteditable="true"], [contenteditable=""]')
      .filter((el) => isChatComposer(el))
      .filter((el) => {
        const ph = (el.placeholder || '') + ' ' + (el.className || '') + ' ' + (el.getAttribute('aria-label') || '');
        return !/搜索|search|手机号|账号|密码|验证/i.test(ph);
      })
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.top > window.innerHeight * 0.2 && r.width > 120;
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

  // 只认两种发送方式：① 文本精确等于「发送」的按钮；② 回车（BOSS 输入框自己写着
  // 「按Enter键发送」，是站点文档化的方式）。不再用 className 猜，猜错的代价是误点上传。
  function findSendButton() {
    // 真实站点这组操作按钮是 <div class="btn-v2 btn-sure-v2">（实测会话列表搜索那颗就是它），
    // 不再是 <button>，也没有 btn-send 类。旧版只查 `button, [role=button]` → 输入框找到了、
    // 发送按钮永远匹配不到（用户实测「找到了输入框但没找到发送按钮」全线失败）。所以把这套
    // 组件类也并进候选，但**文案仍精确要求「发送」**，避免误抓搜索框那颗「提交」。
    const cand = $$('button, [role="button"], .btn-v2, .btn-sure-v2, [class*="send"]')
      .filter((e) => visible(e) && notMine(e) && !isUploadish(e));
    const txt = (e) => (e.innerText || '').trim();
    const send = cand.filter((e) => txt(e) === '发送');
    if (send.length) {
      return send.find((e) => /btn-send|chat-send|send-btn|sure/i.test(String(e.className || ''))) || send[0];
    }
    // 站点若把发送按钮文案改成「提交」：只认右侧沟通面板里的那颗，左侧会话列表顶部的搜索框也叫「提交」，
    // 用 left >= 28% 把它排除（和认会话身份用的是同一道分界）。
    const submit = cand.filter((e) => txt(e) === '提交' && e.getBoundingClientRect().left >= window.innerWidth * 0.28);
    return submit[0] || null;
  }

  async function clickSendButton() {
    // 先等按钮「出现」：这一轮常常跑在后台标签页里，composer 可能比输入框晚一点才挂上；
    // 旧版第一帧找不到就 return false，等于把「稍等就有」误判成「根本没有」。
    let b = null;
    for (let i = 0; i < 20 && !(b = findSendButton()); i++) await sleep(250);
    if (!b) return false;
    // 再等它从 disabled 解禁（空输入时带 class="… disabled"，opacity .5）。填完字框架会自己摘掉；
    // 实在等不到也点一下，最终以输入框是否清空为准。
    for (let i = 0; i < 10; i++) {
      if (!/disabled/i.test(String(b.className || '')) && !b.disabled) { b.click(); return true; }
      await sleep(250);
      b = findSendButton() || b;   // 解禁后可能是新节点，重找一次再判
    }
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

  // 发出去的持久凭证：写在哪不算，谁写都算 —— 只要「输入框清空」这一瞬间有人留下了记录。
  function markSent(id) {
    try { GM_setValue(SENT_KEY(id), { at: Date.now(), href: location.href }); } catch (e) {}
  }
  function alreadySent(id) {
    try { return !!GM_getValue(SENT_KEY(id), false); } catch (e) { return false; }
  }
  // 凭证是一条岗位一个键，清空列表 / 重置时不一起扫掉就会留下两个互相矛盾的真相：
  // 草稿被清了（「什么都没发过」），凭证还在（「这条发过了」）—— 重抓同一批岗位后
  // 点发送会被「在上一页就已经发出去了」拦住，用户怎么点都发不出去，还以为是脚本坏了。
  function sweepSentCreds() {
    let n = 0;
    try {
      const st = (typeof GM_listValues === 'function') ? GM_listValues() : [];
      st.forEach((k) => {
        if (String(k).indexOf('bgSent:') === 0 || String(k).indexOf('sendDone:') === 0) { GM_deleteValue(k); n++; }
      });
    } catch (e) {}
    return n;
  }

  // 填 + 点发送 + 确认。成功信号只认「输入框被清空」。
  // jobId 传进来只为一件事：在「确实发出去了」的这一瞬间，由看见的人（可能是后台标签页）
  // 往油猴存储写一条持久凭证。面板那一页要是刚好在这之后被跳转销毁，草稿上的「已发送」就没了，
  // 续跑会对着同一个 HR 再发一遍 —— 这条凭证就是用来堵这个口子的。
  async function sendIntoChat(inp, text, jobId) {
    // 第二道闸：所有调用方都从 findChatInput 拿元素，这里再确认一次它不是搜索框/兑换码框。
    // 旧版就是因为把收藏列表页右侧的普通 input 当聊天框，招呼语被填进了 VIP 兑换码输入框。
    if (!isChatComposer(inp)) {
      return { ok: false, why: '这一页没有真正的聊天输入框，不会往搜索框/兑换码框之类的输入框里填字' };
    }
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
    if (cleared && jobId) markSent(jobId);
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
  async function sendMessage(text, jobId) {
    const inp = findChatInput();
    if (!inp) return { ok: false, noComposer: true, why: '这一页没有聊天输入框（不在沟通页）' };
    // 站在沟通页上也可能停在上一个 HR 的会话：能认出「不是这条岗位」就绝不填字。
    // 认不出来的（职位名没渲染）仍然按用户点的那条发，发前日志会提醒核对一眼。
    const job = jobs.find((x) => x.id === jobId) || {};
    const vd = chatPageVerdict({ jobId: jobId, title: job.title || '', company: job.company || '', chat: null });
    if (vd.v === 'no') {
      return { ok: false, why: '这一页打开的不是这条岗位的沟通会话（' + (vd.why || '职位名对不上') + '），为避免发错人，没有往输入框里填字' };
    }
    if (vd.v === 'unknown') log('· 这一页认不出当前会话的职位名，就按你点的「' + jobTitle(jobId) + '」发送，发前可在沟通页核对一眼');
    return await sendIntoChat(inp, text, jobId);
  }

  /* ---------------------------------------------------------------- 批处理 */

  const runner = { running: false, paused: false };

  /* ---------------- v0.5.3：批量计划落盘，整页跳转之后还能接着跑 ----------------
   * 用户实测：队列里显示「生成中」时点到别的页面（BOSS 的列表页/详情页之间就是整页跳转），
   * 这一页的 JS 上下文当场销毁 —— 批量循环、队列状态、日志全跟着没，回来一切退回「待处理」。
   * 面板里切标签不会这样（循环活在内存里，已经有用例钉着），所以要修的是「换页面」。
   * GM 存储活得比页面久：jobs/drafts/cfg 本来就在里面，缺的是「这一轮到底要跑哪几条」。
   */
  const pageToken = uid() + uid();      // 本页面身份：心跳里带着它，别的页面据此判断计划归谁
  const BATCH_LIVE_MS = 15000;          // 心跳断掉超过这个数，才认为上一页真的没了（别和还在跑的批量抢同一份计划）
  let planBeat = 0;
  let lastLeft = -1;                    // 上一轮看到的「还剩几条 + 哪几条在写」，变了才重画队列
  let lastExSig = -1;                   // 生成器日志的长度，变了才重画日志页
  const inFlight = [];                  // 这一页正在生成的岗位 id（写进计划，别的页面据此画「生成中」）
  let llmLive = 0;                      // 此刻全脚本在飞的大模型请求数（含单条手点，不只批量）
  const llmCalls = [];                  // 每次 HTTP 请求的起止时间戳：批量结束时算「实际并发度」
  function llmMark(t0, label) {
    llmCalls.push({ s: t0, e: Date.now(), _label: label || '' });
    if (llmCalls.length > 300) llmCalls.splice(0, llmCalls.length - 300);
  }
  let batchTargets = [];                // 这一轮要跑的那几条：「停止批量」得立刻据此把计划退成「没人认领」，
                                        // 不能等那条还在飞的大模型请求回包（v0.5.5 把轮询泵换成 worker 链之后就更要紧）
  let spawning = false;                 // 正在等生成器标签页起来（这段时间别再派第二个）
  let stopReq = false;                  // 执行者是被「停止批量」按下的，不是自己跑完的

  function readPlan() {
    const p = load(K.batch, null);
    if (!p || !Array.isArray(p.ids) || !p.ids.length) return null;
    if (p.day !== today()) return null;   // 隔夜的计划不复活：今日上限、简历、岗位列表都可能已经不是当时那份
    return p;
  }
  // 计划有人正在跑吗（而且不是我这一页自己在跑）：所有「要不要接管 / 该不该发指令」的判断都问这一句
  function planOwnerLive(p) {
    p = p || load(K.batch, null);
    return !!(p && p.by && p.by !== pageToken && Date.now() - Number(p.tick || 0) < BATCH_LIVE_MS);
  }
  // 只当名词用：三处日志都是「<谁> + 干了什么」，别再往中间塞「正在跑这一轮的」这种定语，
  // 否则拼出来是「检测到这一轮的正在跑这一轮的那个标签页没了」，用户读不通。
  function ownerName(p) { return p && p.role === 'exec' ? '生成器标签页' : '另一个标签页'; }
  // 这一条还算「没跑完」吗：半自动看草稿在不在，全自动看有没有真的发出去。
  // 已经取消勾选/移出队列的不算 —— 否则续跑会守着一堆永远做不完的岗位反复自动接管。
  function planLeft(p) {
    if (!p) return [];
    return p.ids.filter((id) => {
      if (!isSelected(id)) return false;
      if (alreadySent(id) || (drafts[id] && drafts[id].sent)) return false;
      if (!p.autoSend && drafts[id] && !isDraftStale(id)) return false;
      return true;
    });
  }
  // live=true：这一页正在跑，心跳会一直续；live=false：故意停下来的（点「停止批量」/一轮跑完没剩），
  // 只等用户自己点「继续上次批量」，别的页面不许自动接管。
  function writePlan(ids, live, role) {
    if (!ids || !ids.length) { try { GM_deleteValue(K.batch); } catch (e) {} return; }
    save(K.batch, {
      ids: ids.slice(), autoSend: !!cfg.autoSend, day: today(),
      tick: Date.now(), by: live ? pageToken : '',
      // role='exec' → 认领这份计划的是脚本开出来的生成器标签页（面板据此把「停止/暂停」发成指令而不是自己动手）
      role: live && role === 'exec' ? 'exec' : 'page',
      started: Date.now(), gen: [], pause: false, stop: 0, respawn: 0
    });
  }
  // 把「这一页正在生成哪几条」公布出去：用户在别的页面上跳来跳去时，队列里那枚「生成中」
  // 就是靠它画出来的（旧版它是本页内存里的 states，一跳就没了 —— 那正是他报的现象）。
  function publishGen() {
    const p = load(K.batch, null);
    if (!p || p.by !== pageToken) return;
    p.gen = inFlight.slice();
    save(K.batch, p);
  }
  // 执行者只听一件事：存储里那份计划上别人留下的指令。
  // pause/stop 写在计划里而不是写在内存里，因为按按钮的那一页和执行的那一页已经不是同一页了。
  function pullSignals() {
    const p = load(K.batch, null);
    if (!p || p.by !== pageToken) return;
    if (!!p.pause !== runner.paused) {
      runner.paused = !!p.pause;
      log(runner.paused ? '· 收到暂停（这一页是执行者，暂停生效在生成/发送的节奏上）' : '· 收到继续');
      updateRunnerUI();
    }
    if (Number(p.stop) && Number(p.stop) >= Number(p.started || 0) && runner.running) {
      runner.running = false; stopReq = true;
      // 就地把手上这份计划退成「没人认领」：在飞的那条请求可能要十几秒才回，
      // 这段时间不许让别的页面以为这儿还有人跑（它们该看到「可续跑 N 条」并给出那颗按钮）。
      finishPlan(batchTargets);
      log('· 收到停止：这一轮到此为止，剩下' + (isExec ? '的条数回到 BOSS 页面点「继续上次批量」' : '的条数还能点「继续上次批量」') + '接上');
      updateRunnerUI();
    }
  }
  function signalOwner(kind, val) {
    const p = load(K.batch, null);
    if (!planOwnerLive(p)) { log('· 现在没有正在跑的批量，这条指令没处发'); return false; }
    p[kind] = val; save(K.batch, p);
    log('· 已通知' + ownerName(p) + (kind === 'stop' ? '停止（剩下' + planLeft(p).length + '条可以点「继续上次批量」接上）'
      : (val ? '暂停' : '继续')));
    return true;
  }
  function startBeat() {
    stopBeat();
    planBeat = setInterval(() => {
      const p = load(K.batch, null);
      if (!p || p.by !== pageToken) { stopBeat(); return; }
      p.tick = Date.now(); p.gen = inFlight.slice(); save(K.batch, p);
      if (isExec) { try { document.title = EXEC_TITLE; } catch (e) {} }   // 心跳顺手改名：用户一眼能认出该留哪一页
      pullSignals();
      saveLog(true);   // 心跳顺手把日志副本刷进存储：页面被跳转顶掉时最多丢最近这一两秒的行
    }, 2000);
  }
  function stopBeat() { if (planBeat) { clearInterval(planBeat); planBeat = 0; } }
  // 一轮下来（自然跑完 / 被「停止批量」按下）后剩多少：清零就没有续跑的必要了。
  function finishPlan(ids) {
    stopBeat();
    if (!ids || !ids.length) return;
    const left = planLeft({ ids: ids, autoSend: !!cfg.autoSend });
    if (!left.length) { try { GM_deleteValue(K.batch); } catch (e) {} return; }
    const cur = load(K.batch, null);
    // 别的页面正在跑同一份计划（心跳还活着）就别把人家盖掉
    if (cur && cur.by && cur.by !== pageToken && Date.now() - Number(cur.tick || 0) < BATCH_LIVE_MS) return;
    writePlan(ids, false);
    log('· 这一轮还剩 ' + left.length + ' 条没跑完：在「队列」页点「继续上次批量」接着跑（换页面被打断也是这么接上）');
    // 心跳已经被自己停掉了（stopBeat），没有下一次「顺手刷日志」了：这一行必须当场落盘，
    // 否则下一页 restoreLog 捞不到它，用户看见的还是「跳一次页面日志一片空白」。
    saveLog(true);
  }
  // 交接单还躺着没人认领 = 生成器正在起来的路上，这一页什么都别做（否则会多开一个生成器）
  function execPending() {
    const r = load(K.exec, null);
    return !!(r && r.token && !r.claimed && Date.now() - Number(r.ts || 0) < 30000);
  }
  // 页面重启后看着那份「没人认领、心跳也断了」的计划：自动接着跑（可在设置里关掉）。
  function watchResume() {
    setInterval(() => {
      if (runner.running || spawning || execPending()) { lastLeft = -1; return; }
      // 每轮先跟存储对一次账：别的标签页这一会儿生成的草稿、改的勾选、发的条数都得看见，
      // 否则这一页守着自己那份旧快照，把「还剩几条」算错、回写时把别人的成果盖掉。
      const synced = syncFromStorage();
      const p = readPlan();
      const left = p ? planLeft(p) : [];
      // 「哪几条正在被生成器写着」变了也要重画：只盯「还剩几条」的话，一条刚进生成队列时
      // 剩下的条数一点没动，徽章会一直停在「待处理」，用户就又以为生成被打断了。
      const sig = left.length + '|' + ((p && p.gen) || []).join(',') + '|' + isPaused();
      if (sig !== lastLeft || synced) { lastLeft = sig; updateStat(); if (curTab === 'queue') renderQueue(); }
      const exSig = execLogTail().length;
      if (curTab === 'log' && exSig !== lastExSig) { lastExSig = exSig; renderLog(); }
      if (!left.length || !cfg.autoResume || !p.by) return;
      if (Date.now() - Number(p.tick || 0) < BATCH_LIVE_MS) return;   // 那一页也许还在跑，别抢
      if (Date.now() - Number(p.respawn || 0) < 30000) return;        // 别的标签页刚派过生成器，等它起来，别重复派
      log('· 检测到' + ownerName(p) + '被页面跳转打断或已经没了（那一页的 JS 上下文不在了），还剩 ' + left.length + ' 条，自动重新开一个接着跑（不想自动就到「设置」里关掉「页面跳转后自动接着跑」）');
      p.respawn = Date.now(); save(K.batch, p);
      startBatch(left);
    }, 3000);
  }

  /* ---------------- v0.5.5：把这一轮交给后台的「生成器」标签页 ----------------
   * 为什么非得换一页：用户报的现场是「队列里显示生成中，我点到别的页面，全部退回待处理」。
   * BOSS 的列表页/详情页之间就是整页跳转，跳一次，那一页的 JS 上下文当场销毁 ——
   * 循环、内存里的状态、还没回来的大模型请求，全跟着没。落盘续跑（v0.5.3）只能"事后接上"，
   * 接上的那几秒里生成确实是停的，而且他还要吃一道「是否离开网站？」的弹窗。
   * 唯一靠得住的做法是让循环活在他不会跳走的那一页：脚本自己开、自己认、用完自己关的后台标签页。
   */
  function execBase() {
    // 生成只需要存储和 HTTP，开在哪一页都行，只有一页不能选：沟通页。
    // 那上面有真的输入框，别让执行者有机会把自己当成发送现场（脚本只在确认过身份的那一页点按钮）。
    if (!looksLikeChat()) return location.href.split('#')[0];
    const j = selected()[0] || {};
    const m = /^(https?:\/\/[^/]*zhipin\.com[^#]*)/i.exec(String(j.url || ''));
    return m ? m[1] : 'https://www.zhipin.com/';
  }
  // 返回 'ok' / 'taken'（交接单被别的页面换了）/ 'no-gm' / 'open-failed' / 'timeout'
  async function spawnExecutor(ids) {
    if (typeof GM_openInTab !== 'function') return 'no-gm';
    const token = uid() + uid();
    save(K.exec, { token: token, ts: Date.now(), ids: ids.slice(), claimed: '' });
    try { GM_openInTab(execBase() + '#' + EXEC_MARK + token, { active: false, insert: true, setParent: true }); }
    catch (e) { return 'open-failed'; }
    const t0 = Date.now();
    while (Date.now() - t0 < 25000) {
      await sleep(700);
      const r = load(K.exec, null);
      if (r && r.token !== token) return 'taken';
      if (r && r.claimed) return 'ok';
      const p = load(K.batch, null);
      if (p && p.role === 'exec' && p.by && Date.now() - Number(p.tick || 0) < BATCH_LIVE_MS) return 'ok';
    }
    return 'timeout';
  }
  // 所有「开始批量」的入口（队列页按钮、继续上次批量、自动接管）都走这一条。
  async function startBatch(ids) {
    if (spawning) return;
    if (!ids || !ids.length) { log('先在「岗位」页勾选要处理的岗位'); return; }
    if (!cfg.bgExecutor) { runBatch(ids); return; }
    const p0 = readPlan();
    if (planOwnerLive(p0)) {
      log('· ' + ownerName(p0) + '正在跑这一轮（剩 ' + planLeft(p0).length + ' 条），不用重复开始');
      return;
    }
    spawning = true; updateStat();
    try {
      log('· 正在把这一轮交给后台的「生成器」标签页（最多等 25 秒）');
      const r = await spawnExecutor(ids);
      if (r === 'ok') {
        log('✓ 生成器已接手：这一轮跑 ' + ids.length + ' 条，你去 BOSS 里随便跳、切标签、最小化面板都不会打断它');
        return;
      }
      if (r === 'taken') { log('· 交接单被别的标签页更新了，这一页不再派第二个生成器'); return; }
      log('· 生成器标签页没能起来（' + (r === 'no-gm' ? '这个环境没有 GM_openInTab'
        : r === 'open-failed' ? '开标签页失败'
        : '25 秒内没人认领：多半是那一页没被油猴注入，或被站点弹的登录/验证码挡住了') + '）—— 这一轮先在你正在看的这一页里跑');
      await runBatch(ids);
    } finally { spawning = false; updateStat(); }
  }

  // 这一页是不是「被脚本开出来的生成器」：地址上的标记要和交接单里的 token 对上，而且必须比
  // 交接单还新（两个条件缺一不可，理由和发送用的 #bgSend= 一模一样：只看新不新，用户随手开的
  // 那一页会被抢走；只看标记，他从旧地址复制来的那一页也会被当成生成器）。
  function execRequest() {
    const req = load(K.exec, null);
    if (!req || !req.token || !Array.isArray(req.ids) || !req.ids.length) return null;
    if (req.claimed) return null;                              // 已经有生成器在跑这一轮
    if (!execToken || execToken !== req.token) return null;   // 没标记，或标记是上一轮留下的
    let fresh = true;
    try { fresh = (performance.timeOrigin || 0) >= Number(req.ts) - 1500; } catch (e) {}
    return fresh ? req : null;
  }
  function closeExec(ms) {
    stopBeat();
    // 「后台标签用完自动关闭」是关的，就留着这一页：标题写着「请别关这个标签页」，用户看得见
    if (!cfg.autoCloseDetail) return;
    setTimeout(() => { saveLog(true); try { window.close(); } catch (e) {} }, ms);
  }
  // 生成器那一页要做的事：认领这一轮 → 跑 → 收尾。
  // 认领要「先看有没有人在跑」再「写自己的心跳」，最后读回来确认还是自己 —— 分这三步是因为
  // 可能有两个标签页同时拿着同一张交接单（站点把那一跳变成新标签、或用户复制过带标记的地址）：
  // 只有把这一轮写进计划并且读回来仍是自己那一页才真的跑，另一个直接收工，绝不出现两轮并发。
  async function runExecutor(ex) {
    log('· 生成器标签页起来了：这一页只跑这一轮，不建面板，跑完自己关');
    const p0 = load(K.batch, null);
    if (p0 && p0.by && p0.by !== pageToken && Date.now() - Number(p0.tick || 0) < BATCH_LIVE_MS) {
      log('· 已经有一轮在跑了（剩 ' + planLeft(p0).length + ' 条），这一页不抢，收工');
      closeExec(4000); return;
    }
    writePlan(ex.ids, true, 'exec');
    await sleep(rnd(250, 700));
    const mine = load(K.batch, null);
    if (!mine || mine.by !== pageToken) { log('· 另一页同时认领了这一轮，这一页收工（只会有一页真的在跑）'); closeExec(4000); return; }
    const cur = load(K.exec, null);
    if (!cur || cur.token !== execToken) { log('· 交接单已经不是这一页的了，收工'); stopBeat(); return; }
    cur.claimed = pageToken; cur.claimedAt = Date.now(); save(K.exec, cur);
    await runBatch(ex.ids);
    const left = planLeft(load(K.batch, null));
    log(left.length ? '· 生成器这一轮结束，还剩 ' + left.length + ' 条：回 BOSS 页面点「继续上次批量」会再开一个生成器接着跑'
      : '· 生成器这一轮全部跑完，这个标签页马上自己关掉');
    closeExec(left.length ? 20000 : 6000);
  }

  async function runBatch(ids) {
    if (runner.running) { log('批量任务已在运行'); return; }
    // 开跑前先把这一页的视图对齐存储：接管别人被打断的那一轮时，手里这份快照可能是老的，
    // 拿它判「哪几条还没草稿」会把已经写好的重做一遍，拿它整块回写还会把人家抹掉。
    syncFromStorage();
    runner.running = true; runner.paused = false; stopReq = false;
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
    refreshDetails();
    // 计划要趁「还没开始花时间」就落盘：下面补 JD、并发生成、逐条发送，任何一步都可能被一次
    // 整页跳转拦腰打断 —— 这一页的循环一死就什么都想不起来了，只有存储里这份 ids 还在。
    writePlan(targets, true, isExec ? 'exec' : 'page');
    batchTargets = targets.slice();
    startBeat();
    // 批量前先补齐缺的 JD：有 JD 的先开始生成，没 JD 的后台抓、抓完自动加入生成队列。
    // 不再阻塞等待全部抓完，避免已就绪的岗位干等。
    const needDetail = cfg.autoFetchDetail ? targets.filter((id) => !hasDetail(id)) : [];
    let fetchDone = needDetail.length === 0;   // 没有需要补 JD 的，直接算完成
    if (needDetail.length) {
      log('· 批量启动：' + (targets.length - needDetail.length) + ' 个已有 JD 立即生成，' + needDetail.length + ' 个后台补 JD 中');
      fetchDetails(needDetail).then(() => {
        refreshDetails();  // 先把内存里的 details 同步过来，否则 hasDetail 判空
        fetchDone = true;
        // 详情抓完后，把刚才没 JD 但现在有了的岗位重新分配进各模型队列
        const nowReady = needDetail.filter((id) => hasDetail(id));
        if (nowReady.length && runner.running && !stopAll) {
          log('· ' + nowReady.length + ' 个岗位 JD 已到位，加入生成队列');
          nowReady.forEach((id) => {
            const idx = hashId(String(id)) % cfg.models.length;
            modelBuckets[idx].push(id);
          });
        }
      }).catch(() => { refreshDetails(); fetchDone = true; });
    } else {
      log('· 本轮 ' + targets.length + ' 个岗位都有 JD，直接开始生成');
    }
    // ============ v0.5.7：多模型并行 + 组内并发 ============
    // 把 targets 按岗位 id 哈希分配到 cfg.models 的各个模型上，每个模型拿到自己的子队列；
    // 每个子队列内部用 genWorker 池并发跑（worker 数 = min(子队列长度, genConcurrency)），
    // 不同模型的 worker 池同时起跑、互不干扰。这样 3 个模型各包 N/3 条岗位，总吞吐量 ≈ 3 倍单模型。
    const conc = Math.min(8, Math.max(1, Math.round(Number(cfg.genConcurrency) || 3)));
    const batchT0 = Date.now();         // 批量结束时用它圈出「这一轮的请求」算实际并发度
    const ready = [];            // 草稿已就绪、等发送的 id（只有全自动才有人消费）
    let producing = true;        // 生产侧还在跑
    let stopAll = false;         // 消费侧提前收手（上限/停止），生产侧也别再烧 token

    // 按 id 哈希取模分配岗位到各个模型，保证同一条岗位重跑时永远分到同一个模型（草稿指纹不变）
    function hashId(id) {
      let h = 0;
      for (let i = 0; i < id.length; i++) { h = ((h << 5) - h + id.charCodeAt(i)) | 0; }
      return Math.abs(h);
    }
    const modelBuckets = cfg.models.map(() => []);
    // 初始只把有 JD 的岗位放进队列；没 JD 的等 fetchDetails 完成后再补进来
    targets.forEach((id) => {
      if (hasDetail(id)) {
        const idx = hashId(String(id)) % cfg.models.length;
        modelBuckets[idx].push(id);
      }
    });
    log('· 本轮 ' + targets.length + ' 个岗位，' + cfg.models.length + ' 个模型并行（并发生成 ' + conc + ' 路；发送仍逐条排队，间隔 ' +
      Math.round(cfg.delayMin / 1000) + '~' + Math.round(cfg.delayMax / 1000) + ' 秒）');
    cfg.models.forEach((mc, i) => {
      if (modelBuckets[i].length) log('  [' + mc._label + '] ' + mc.model + ' → ' + modelBuckets[i].length + ' 条岗位');
    });

    async function genForBatch(id, modelCfg) {
      if (!runner.running || stopAll) return;
      // 每轮都重新看一眼最新勾选：跑的过程中被取消勾选的岗位直接跳过，既不生成也不发送
      if (!isSelected(id)) {
        log('· 已取消勾选，跳过「' + jobTitle(id) + '」');
        delete states[id];
        return;
      }
      pullSignals();
      if (!runner.running || stopAll) return;
      // 「没 JD 不生成」只在 generateOne 里判一次，批量靠它抛的那条错来跳过（见下面的 catch）：
      // 这里不再抄一份条件，免得两边哪天走岔了，一边拦一边放。
      setJobState(id, '生成中');
      inFlight.push(id); publishGen();
      try {
        let draft = drafts[id] && drafts[id].text;
        if (!draft || isDraftStale(id)) {
          if (draft) log('· 「' + jobTitle(id) + '」的草稿已过期（简历/岗位/提示词变过），重新生成');
          draft = await generateShared(id, modelCfg);     // 并发去重：批量和手点同一行只发一条请求
        }
        if (!cfg.autoSend) {
          setJobState(id, '待确认');
          log('已生成草稿，去「队列」页确认后点发送 → ' + jobTitle(id));
          return;
        }
        ready.push(id);
      } catch (e) {
        // 「没 JD 不生成」的唯一判据是 generateOne 抛的那条 noJd 错；这里只把它翻译成
        // 队列里看得懂的标记，不重复判条件。既然一个请求都没发，也就不必等反爬间隔。
        if (e && e.noJd) {
          setJobState(id, '缺 JD 已跳过');
          log('✗ 跳过「' + jobTitle(id) + '」：' + e.message);
          return;
        }
        setJobState(id, '出错');
        log('✗ ' + id + ' 失败：' + e.message);
      } finally {
        const at = inFlight.indexOf(id);
        if (at >= 0) inFlight.splice(at, 1);
        publishGen();
      }
    }

    // 每条 worker 就是一串「上一条的回包一到，立刻发下一条」，中间不靠定时器排队。
    // 为什么不用原来那个每 120ms 看一眼队列的泵：这一轮现在跑在后台标签页里，
    // 浏览器会把隐藏页面的定时器压到一秒一次（隐藏久了压到一分钟一次），轮询式的泵会被压慢；
    // 而大模型的回包是网络回调、不受这套节流影响 —— 所以生成阶段干脆一个定时器都不依赖。
    async function genWorker(queue, modelCfg) {
      while (runner.running && !stopAll) {
        if (runner.paused) { await sleep(600); continue; }
        if (queue.length) {
          const id = queue.shift();
          if (id === undefined) break;
          await genForBatch(id, modelCfg);
        } else if (!fetchDone) {
          // 队列空了但 fetchDetails 还没完，等着新岗位进来
          await sleep(800);
        } else {
          break;   // 队列空且 fetch 也完了，收工
        }
      }
    }

    const producer = (async () => {
      const allWorkers = [];
      modelBuckets.forEach((bucket, i) => {
        // 初始队列为空但 fetch 还没完时，也得开一个 worker 等着；否则 fetchDetails 回调里
        // 把岗位推进 bucket 之后没人消费，整条流水线就卡死了。
        const wCount = bucket.length
          ? Math.min(conc, bucket.length)
          : (!fetchDone ? 1 : 0);
        for (let w = 0; w < wCount; w++) {
          allWorkers.push(genWorker(bucket, cfg.models[i]));
        }
      });
      await Promise.all(allWorkers);
      producing = false;
    })();

    const consumer = (async () => {
      if (!cfg.autoSend) { await producer; return; }   // 半自动：只生成，发送由人在队列页逐条点
      while (true) {
        if (!runner.running) break;
        if (runner.paused) { await sleep(500); continue; }
        const id = ready.shift();
        if (id === undefined) { if (!producing) break; await sleep(200); continue; }
        if (Number(cfg.maxPerDay) - stats.sent <= 0) { log('触达今日发送上限，停止'); break; }
        if (sendBusy[id]) { ready.unshift(id); await sleep(400); continue; }  // 这一行正被手点发送，别抢
        // 走 sendOne()：和「开始批量」以外的两个入口（行内「发送」「生成并发送」）同一份实现，
        // 包括今日上限、模式解释、发送失败标记，不再各写一套。
        await sendOne(id);
        updateRunnerUI();
        await sleep(rnd(cfg.delayMin, cfg.delayMax));
      }
      stopAll = true;
      await producer;
    })();

    await consumer;
    // 并发是不是真的并发，别靠嘴说：把这一轮每次请求的起止时间摊开算峰值重叠和墙上时间。
    // 多模型并行时再按模型拆开报一段，方便你看每个模型的延迟分布。
    const mine = llmCalls.filter((t) => t.e >= batchT0);
    if (mine.length) {
      const ev = [];
      mine.forEach((t) => { ev.push([t.s, 1], [t.e, -1]); });
      ev.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
      let cur = 0, peak = 0;
      ev.forEach((x) => { cur += x[1]; if (cur > peak) peak = cur; });
      const wall = Math.max.apply(null, mine.map((t) => t.e)) - Math.min.apply(null, mine.map((t) => t.s));
      const sum = mine.reduce((a, t) => a + (t.e - t.s), 0);
      log('· 本轮生成实测：' + mine.length + ' 次请求，墙上 ' + (wall / 1000).toFixed(1) + 's，累计 ' +
        (sum / 1000).toFixed(1) + 's，峰值同时在飞 ' + peak + ' 条，实际并发度 ' +
        (wall > 0 ? (sum / wall).toFixed(1) : '?'));
      // 按模型拆段
      cfg.models.forEach((mc, i) => {
        const mcCalls = mine.filter((t) => t._label === mc._label);
        if (!mcCalls.length) return;
        const mEv = [];
        mcCalls.forEach((t) => { mEv.push([t.s, 1], [t.e, -1]); });
        mEv.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
        let mCur = 0, mPeak = 0;
        mEv.forEach((x) => { mCur += x[1]; if (mCur > mPeak) mPeak = mCur; });
        const mWall = Math.max.apply(null, mcCalls.map((t) => t.e)) - Math.min.apply(null, mcCalls.map((t) => t.s));
        const mSum = mcCalls.reduce((a, t) => a + (t.e - t.s), 0);
        log('  [' + mc._label + '] ' + mc.model + '：' + mcCalls.length + ' 次，墙上 ' + (mWall / 1000).toFixed(1) + 's，累计 ' +
          (mSum / 1000).toFixed(1) + 's，峰值 ' + mPeak + '，实际并发度 ' + (mWall > 0 ? (mSum / mWall).toFixed(1) : '?'));
      });
    }
    runner.running = false; updateRunnerUI(); renderQueue();
    finishPlan(targets);
    log('批量任务结束（今日已发 ' + stats.sent + '/' + cfg.maxPerDay + '）');
    saveLog(true);   // 「还剩几条」这行必须进存储：下一页就是靠它知道自己该接什么
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
    const out = await waitSendReceipt(job, 60000, 12000);
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

  /* ------------------------- 发送路线 A（默认）：在后台标签的列表页上点卡片自己的沟通按钮 */

  // 用户实测反馈：旧路线一次发送要「开详情页 → 等详情页渲染出沟通按钮 → 点它 → 才到沟通页」，
  // 白等一个详情页。而收藏/感兴趣列表每张卡片右上角本来就有「继续沟通 / 立即沟通」（悬停才显示，
  // 用户实测截图里就是这个手势），点它一步就到沟通页。于是改成：另开一个列表页标签（和旧版开详情页
  // 同一手法）→ 在这张卡片上点 → 后半程的接力牌完全照旧。
  //
  // 三条硬约束（每条都有 test/ui-listsend.html 的 case 钉着，改坏一条就有断言变红）：
  //  ① 绝不在用户正在看的标签页里点 —— 一点就整页跳走，面板连同 await 一起没。
  //     真正的保证是「认领只在 boot() 里判一次」：已经开着的页面不会再判第二遍（ui-listsend 有专门
  //     一条断言：发送结束后再往存储里塞第二个请求，这一页也不许动）。在此之上再加两道凭据：
  //     这一页必须带着脚本开它时写进 URL 的 #bgSend= 标记（地址被站点洗掉时认导航记录里的同一标记），
  //     并且必须是**这次请求发出之后**才加载的。为什么两个都要：只看「新不新」，用户在发送途中
  //     自己新开/刷新的那个列表页必然更新，会被它认领；只看「有没有标记」，用户从上一条复制过来的
  //     旧地址（带着旧的 #bgSend）也会被认领。两条各有一个 case 盯着。最后一道是 sendClaim：
  //     同一个 req.ts 只允许一个标签页认领（claimed 那个 case）。
  //  ② 只点这张卡片里的按钮：卡片用「卡片自己 href 里的 jobId == 这条岗位 id」定位，不看 DOM 顺序、
  //     不看标题文本；再要求按钮自己的 redirect-url 里的 jobId 也对得上，对不上就停手。
  //  ③ 走不通（卡片不在这一屏之后 / 卡片上没有沟通按钮）就退回详情页入口，别把失败甩给用户。
  const myTabMark = Math.random().toString(36).slice(2) + Date.now().toString(36);

  function listSendUrl(listUrl, id) {
    return listUrl + (listUrl.indexOf('#') >= 0 ? '&' : '#') + 'bgSend=' + key0(id);
  }

  // #bgSend= 标记在不在这一页上：先看当前地址，再看「那一跳的原始 URL」。
  // 站点是 SPA，加载后常用 history.replaceState 往地址上补 _k / lid，hash 可能被抹掉，
  // 但导航计时记录里还是刚进来那个 URL —— 沟通页认身份用的是同一套证据（见 navUrlParams）。
  function hasSendMark(req) {
    const want = 'bgSend=' + key0(req.id);
    if (String(location.hash || '').indexOf(want) >= 0) return true;
    try {
      const n = (performance.getEntriesByType('navigation') || [])[0];
      return !!(n && String(n.name || '').indexOf(want) >= 0);
    } catch (e) { return false; }
  }

  // 列表页 URL 比对：站点会自己往地址上补 _k / lid 这类时间戳参数，但 tab/tag 决定
  // 「这是职位收藏还是感兴趣」，开错列表页就找不到卡片，所以后者必须一致。
  function sameListPage(a, b) {
    const na = normalizeUrl(a), nb = normalizeUrl(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    try {
      const A = new URL(na), B = new URL(nb);
      if (A.origin + A.pathname !== B.origin + B.pathname) return false;
      const pa = qsParams(A.search), pb = qsParams(B.search);
      return ['tab', 'tag', 'type'].every((k) => !pa[k] || !pb[k] || String(pa[k]) === String(pb[k]));
    } catch (e) { return false; }
  }

  function isScriptListSendTab(req) {
    if (!req || req.via !== 'list' || !req.listUrl) return false;
    if (!sameListPage(req.listUrl, location.href)) return false;
    if (!hasSendMark(req)) return false;                            // 没有脚本留下的标记：这是用户自己开的页
    let fresh = false;
    try { fresh = (performance.timeOrigin || 0) >= (Number(req.ts) || 0) - 1500; } catch (e) {}
    if (!fresh) return false;                                       // 标记是上一条留下的：这一页比请求还老
    try {
      const c = GM_getValue('sendClaim', null);
      if (c && c.ts === req.ts) return false;                      // 已被别的标签页认领，一个请求只执行一次
      GM_setValue('sendClaim', { ts: req.ts, by: myTabMark });
    } catch (e) { return false; }
    return true;
  }

  // 用 href 里的 jobId 定位卡片：不看顺序、不看标题文本，所以「点错卡片」没有发生的机会
  function findJobCard(id) {
    if (!id) return null;
    const links = $$('a').filter((a) => {
      if (!notMine(a)) return false;
      const href = a.href || '';
      if (!/job_detail|jobDetail|\/job\//.test(href)) return false;
      const jid = jobIdFromHref(href);
      return !!jid && sameJobId(jid, id);
    });
    return links.length ? findCard(links[0]) : null;
  }

  // 卡片里那颗「继续沟通 / 立即沟通」。列表页上它平时 display:none、悬停才显示，
  // 所以这里刻意不要求 visible()：element.click() 对隐藏元素照样会触发绑在它上面的处理器。
  // 「取消兴趣」文案里也带「取消」，必须排掉，别把收藏点没了。
  function pickChatEntry(node) {
    const want = /^(立即沟通|继续沟通|打招呼|聊一聊)$/;
    const cand = $$('a, button, [role="button"], span, div', node)
      .filter((e) => notMine(e) && !isUploadish(e) && !/取消兴趣|取消收藏|不感兴趣/.test((e.innerText || '').trim()));
    let hit = cand.filter((e) => want.test((e.innerText || '').trim()));
    hit = hit.filter((e) => !hit.some((o) => o !== e && e.contains(o)));           // 只留最里层那颗 <a>
    if (hit.length) return hit[0];
    hit = cand.filter((e) => /startchat/i.test(e.className || '') || e.getAttribute('redirect-url') ||
      (e.hasAttribute && e.hasAttribute('data-isfriend')));
    hit = hit.filter((e) => !hit.some((o) => o !== e && e.contains(o)));
    return hit[0] || null;
  }

  // 这一层里所有岗位链接是不是都指向同一条岗位？用来划清「往上找按钮」的边界：
  // 一旦某一层装进了别的岗位卡片，就绝不能再往上 —— 否则就是拿 B 的按钮发 A 的话。
  function cardIsOnlyThisJob(node, id) {
    if (!id) return false;
    const links = $$('a', node).filter((a) => /job_detail|jobDetail|\/job\//.test(a.href || ''));
    if (!links.length) return false;
    return links.every((a) => { const j = jobIdFromHref(a.href); return !j || sameJobId(j, id); });
  }

  // 真实列表页（用户截图）里那颗按钮在卡片右上角、和岗位标题不在一起：它可能是标题的
  // 「同层兄弟」甚至「上一层的兄弟」，而 findCard 按文字量/链接数取到的那一层未必包住它。
  // 所以从卡片往上再找几层，但每上一层都先确认「这一层里只有这一条岗位」。
  function findCardChatEntry(card, id) {
    let node = card;
    for (let up = 0; node && up < 4; up++) {
      if (!cardIsOnlyThisJob(node, id)) break;
      const hit = pickChatEntry(node);
      if (hit) return hit;
      node = node.parentElement;
    }
    return null;
  }

  // 站点靠 CSS :hover 显示按钮，真人是先悬停再点。这里补一串鼠标事件把样式和可能的 JS 悬停逻辑走一遍。
  function hoverReveal(el) {
    if (!el) return;
    try { if (el.scrollIntoView) el.scrollIntoView({ block: 'center' }); } catch (e) {}
    ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove'].forEach((t) => {
      try {
        el.dispatchEvent(new MouseEvent(t, {
          bubbles: (t === 'pointerover' || t === 'mouseover' || t === 'mousemove'),
          cancelable: true, view: window
        }));
      } catch (e) {}
    });
  }

  async function sendViaListTab(job, text, fillOnly) {
    const listUrl = String(job.listUrl || '').split('#')[0];
    if (!/^https?:/i.test(listUrl)) {
      return { ok: false, needJobTab: true, why: '这条岗位没记下所在的列表页（老数据或抓取时没拿到），这次走详情页入口' };
    }
    GM_setValue('sendClaim', null);
    GM_setValue('sendReq', {
      via: 'list', listUrl: listUrl, url: job.url, text: text, id: job.id, ts: Date.now(),
      title: job.title || '', company: job.company || '', fillOnly: !!fillOnly
    });
    GM_openInTab(listSendUrl(listUrl, job.id), { active: true, insert: true, setParent: true });
    const out = await waitSendReceipt(job, 60000, 25000);
    if (!out) {
      return {
        ok: false, needJobTab: true,
        why: '列表页标签 60s 内没回执（列表页没打开、被登录态挡住，或那张卡片上的沟通按钮点不动）'
      };
    }
    if (!out.ok && !out.why) out.why = '列表页标签报告发送未确认（点了发送但输入框没清空）';
    return out;
  }

  // 在脚本自己开出来的那个列表页标签里执行：找到这张卡片 -> 悬停 -> 点它自己的沟通按钮 -> 后半程交给接力牌
  async function runListSend(req) {
    await sleep(rnd(1500, 2800));
    let card = null;
    const t0 = Date.now();
    let step = 0;
    while (Date.now() - t0 < 12000 && !card) {
      card = findJobCard(req.id);
      if (card) break;
      // 列表页是懒加载的：边滚边找，滚到底也没有就走退回。
      // 三种写法都来一遍：真实浏览器里三种都能派发 scroll 事件，但「谁是滚动容器」因站点而异
      // （body 带 overflow 样式时得写 body.scrollTop），headless 实测只认 documentElement.scrollTop。
      try {
        const y = Math.min(document.body.scrollHeight, window.innerHeight * (1.5 + step * 1.5));
        window.scrollTo(0, y);
        document.documentElement.scrollTop = y;
        document.body.scrollTop = y;
      } catch (e) {}
      step++;
      await sleep(900);
    }
    if (!card) {
      return reportSend(req, { ok: false, needJobTab: true, why: '列表页里没找到这张岗位卡片（大概被取消收藏了、在后面几页里，或者列表页改版）' });
    }
    const entry = findCardChatEntry(card, req.id);
    if (!entry) {
      return reportSend(req, { ok: false, needJobTab: true, why: '这张卡片上没有「立即沟通/继续沟通」按钮（站点收起了入口，或这个岗位已经不能沟通）' });
    }
    const p = chatEntryParams(entry);
    if (p && p.jobId && !sameJobId(p.jobId, req.id)) {
      return reportSend(req, { ok: false, why: '卡片里那颗沟通按钮的 redirect-url 指向另一个岗位（jobId 对不上），为避免发错人已停手' });
    }
    const label = (entry.innerText || '沟通').trim();
    // 先立接力牌再点：点完是整页跳转，本上下文当场就没，回执只能由跳过来的沟通页写
    const hop = writeHop({
      jobId: req.id, jobUrl: req.url, title: req.title || '', company: req.company || '',
      text: req.text, from: 'listCard', fillOnly: !!req.fillOnly, chat: p, listUrl: normalizeUrl(req.listUrl)
    });
    hoverReveal(card); hoverReveal(entry);
    entry.click();
    const t1 = Date.now();
    while (Date.now() - t1 < 6000) {
      await sleep(400);
      if (findChatInput()) break;                                   // SPA 没换上下文，就地发
      if (!sameListPage(req.listUrl, location.href)) break;         // 已经跳去沟通页了
    }
    const inp = findChatInput();
    if (!inp) {
      if (!sameListPage(req.listUrl, location.href)) return;        // 正在跳转中：交给跳转后的沟通页（接力牌已写好）
      const tgt = chatEntryTarget(entry);
      if (/^https?:/i.test(tgt)) {
        log('· 点「' + label + '」没出输入框，改用按钮上的 redirect-url 直接跳沟通页');
        writeHop(hop);
        location.href = tgt;
        return;
      }
      clearHop();
      return reportSend(req, { ok: false, needJobTab: true, why: '点了「' + label + '」但这一页始终没出现聊天输入框，也没拿到沟通页地址（站点结构可能变了）' });
    }
    // 沟通界面就地出现在这一页（SPA 没换上下文）：照样走「确认会话身份 → 填 → 发」那一套。
    // 不能因为「按钮是我照着 jobId 点的」就省掉确认 —— 站点完全可能把上一个会话选中。
    return await runHopSend(hop);
  }

  // 详情页那条入口的收尾：点完沟通按钮，输入框就地出现在这一页（SPA 没换上下文）时，填 + 发 + 回执。
  // 列表入口不用这里，它走 runHopSend —— 那边还要过会话身份确认。
  async function finishOnChatPage(req, inp) {
    if (req.fillOnly) {
      fillInput(inp, req.text);
      clearHop();
      return reportSend(req, {
        ok: false, filled: true, how: 'filled',
        why: '已把招呼语填进这一页的输入框，请你自己核对后点「发送」（没标记为已发送）'
      });
    }
    const res = await sendIntoChat(inp, req.text, req.id);
    if (res.ok) GM_setValue('sendDone:' + req.id + location.href, true);
    clearHop();
    return reportSend(req, res);
  }

  // 等后台标签的回执；用完必须把 sendReq / sendHop / sendClaim 撤干净，
  // 否则用户之后自己点开那个页面会被脚本偷偷再发一条。
  async function waitSendReceipt(job, ms, staleMs) {
    const k = key0(job.id);
    const t0 = Date.now();
    let out = null;
    while (Date.now() - t0 < (ms || 60000)) {
      await sleep(600);
      const res = GM_getValue('sendRes', null) || {};
      if (res[k] && (res[k].url === job.url || res[k].jobId === job.id)) {
        out = res[k]; delete res[k]; GM_setValue('sendRes', res); break;
      }
      const pend = GM_getValue('sendReq', null);
      if (pend && pend.id === job.id && Date.now() - pend.ts > (staleMs || 12000)) GM_setValue('sendReq', null);
    }
    const pend2 = GM_getValue('sendReq', null);
    if (pend2 && pend2.id === job.id) GM_setValue('sendReq', null);
    const hop = GM_getValue('sendHop', null);
    if (hop && hop.jobId === job.id) GM_setValue('sendHop', null);   // 同理：地雷不能留
    GM_setValue('sendClaim', null);
    return out;
  }

  // 发送总入口：默认走列表卡片入口，那条路明确走不通（卡片找不到 / 没有沟通按钮）就退回详情页入口。
  // 退回只在「一个请求都没发出去」的情况下发生，所以不会重复打扰同一个 HR。
  async function dispatchSend(job, text, fillOnly) {
    if (cfg.sendViaList) {
      const r = await sendViaListTab(job, text, fillOnly);
      if (r && r.needJobTab) {
        log('· 列表入口没走通（' + (r.why || '未知原因') + '），退回岗位详情页入口');
        return await sendInJobTab(job, text, fillOnly);
      }
      return r;
    }
    return await sendInJobTab(job, text, fillOnly);
  }

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
  //   ② 右侧当前会话的职位卡（实测是 <span class="position-name">28届后端实习生-示例短视频</span>）。
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
    const res = await sendIntoChat(inp, hop.text, hop.jobId);
    if (res.ok) GM_setValue('sendDone:' + hop.jobId + ':hop', true);
    return hopResult(hop, res);
  }

  // 在「被脚本打开的岗位详情页」里执行发送（列表入口走不通时的退回路线）
  async function maybeHandleSendRequest() {
    const req = GM_getValue('sendReq', null);
    if (!req || !req.url) return;
    if (req.via === 'list') return;              // 列表入口的请求由 runListSend 负责，别在这一页点第二遍
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
    return await finishOnChatPage(req, inp);
  }

  function reportSend(req, res) {
    try {
      const all = GM_getValue('sendRes', {}) || {};
      all[key0(req.id)] = {
        url: req.url, jobId: req.id, ok: !!res.ok, why: res.why || '', how: res.how || '',
        filled: !!res.filled, needJobTab: !!res.needJobTab
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
  #bgPanel{position:fixed;right:18px;top:70px;width:400px;max-height:80vh;z-index:2147483646;
    display:flex;flex-direction:column;background:#fff;border:1px solid #d8dee8;border-radius:10px;
    box-shadow:0 8px 30px rgba(0,0,0,.16);font:12.5px/1.45 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#222}
  #bgPanel *{box-sizing:border-box;font-family:inherit}
  #bgHead{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#1a6fd8;color:#fff;border-radius:10px 10px 0 0;cursor:move;flex-wrap:wrap;min-height:34px}
  #bgHead b{font-size:13px;font-weight:600;white-space:nowrap}
  #bgHead .stat{font-size:11px;color:#dbe8fb;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
  #bgTabs{display:flex;gap:1px;padding:5px 8px 0;border-bottom:1px solid #eaeef4;background:#f7f9fc}
  #bgTabs button{padding:5px 10px;border:0;border-radius:5px 5px 0 0;background:transparent;cursor:pointer;font-size:12px;color:#5a6675}
  #bgTabs button.on{background:#fff;color:#1a6fd8;font-weight:600;box-shadow:0 -1px 0 #1a6fd8 inset}
  #bgBody{padding:8px 10px;overflow:auto;max-height:calc(80vh - 88px)}
  #bgBody fieldset{border:1px solid #e6ebf2;border-radius:6px;margin:0 0 8px;padding:6px 8px}
  #bgBody legend{padding:0 4px;font-size:11.5px;color:#7a8698}
  #bgBody .collapsible-fieldset .fieldset-legend-toggle{cursor:pointer;user-select:none}
  #bgBody .collapsible-fieldset .fieldset-legend-toggle .toggle-icon{display:inline-block;margin-right:4px;transition:transform 0.2s;font-size:10px}
  #bgBody .collapsible-fieldset.collapsed .fieldset-content{display:none}
  #bgBody .collapsible-fieldset.collapsed .toggle-icon{transform:rotate(-90deg)}
  #bgBody label{display:block;margin:3px 0 1px;font-size:11.5px;color:#5a6675}
  #bgBody input,#bgBody textarea,#bgBody select{width:100%;padding:5px 7px;border:1px solid #d8dee8;border-radius:5px;font-size:12px;background:#fff}
  #bgBody textarea{resize:vertical}
  #bgBody .row{display:flex;gap:6px;align-items:center}
  #bgBody .row>*{flex:1}
  #bgBody .btns{display:flex;flex-wrap:wrap;gap:5px;margin:5px 0}
  #bgBody button.act{padding:5px 10px;border:1px solid #cdd6e2;background:#fff;border-radius:5px;cursor:pointer;font-size:12px}
  #bgBody button.pri{background:#1a6fd8;border-color:#1a6fd8;color:#fff}
  #bgBody button.warn{background:#e8543f;border-color:#e8543f;color:#fff}
  #bgBody .job{display:flex;gap:6px;padding:5px 5px;border-bottom:1px dashed #eaeef4;align-items:flex-start}
  #bgBody .job .t{flex:1;min-width:0}
  #bgBody .job .t b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #bgBody .job .t i{display:block;font-style:normal;color:#7a8698;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #bgBody .st{font-size:10.5px;padding:1px 5px;border-radius:8px;background:#eef2f7;color:#5a6675;white-space:nowrap}
  #bgBody .kw-row{display:flex;gap:4px;align-items:center;margin:3px 0}
  #bgBody .kw-name{flex:2;min-width:0}
  #bgBody .kw-aliases{flex:3;min-width:0}
  #bgBody .kw-weight{flex:0 0 50px!important;width:50px!important}
  #bgBody .kw-del{flex:0 0 auto!important;width:24px!important;padding:2px 0!important;border:1px solid #e8543f!important;background:#fff!important;color:#e8543f!important;border-radius:4px!important;cursor:pointer;font-size:14px!important;line-height:1.2!important}
  #bgBody .injury-row{display:flex;gap:4px;align-items:center;margin:3px 0}
  #bgBody .injury-word{flex:1;min-width:0}
  #bgBody .injury-del{flex:0 0 auto!important;width:24px!important;padding:2px 0!important;border:1px solid #e8543f!important;background:#fff!important;color:#e8543f!important;border-radius:4px!important;cursor:pointer;font-size:14px!important;line-height:1.2!important}
  #bgBody .st.sent{background:#e6f6ec;color:#1c8a45}
  #bgBody .st.err{background:#fdeceb;color:#c8402f}
  #bgBody .st.run{background:#e8f1fd;color:#1a6fd8}
  #bgBody .st.stale{background:#fff4e5;color:#b26a00}
  #bgBody .draft{background:#f7f9fc;border:1px solid #e6ebf2;border-radius:5px;padding:4px 6px;margin:3px 0 4px;white-space:pre-wrap;font-size:12px}
  #bgBody .draft.stale{opacity:.55;border-style:dashed;border-color:#e8c48a}
  #bgBody .mini{font-size:10.5px;color:#93a0b1}
  #bgBody .mini.warn{color:#b26a00}
  #bgBody .hint{font-size:11px;color:#93a0b1;margin:3px 0 6px}
  #bgBody .danger{color:#c8402f}
  #bgFoot{padding:4px 10px;border-top:1px solid #eaeef4;background:#f7f9fc;color:#5a6675;
    font-size:11px;min-height:20px;border-radius:0 0 10px 10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #bgMin{position:fixed;right:18px;bottom:80px;z-index:2147483646;padding:7px 11px;border:0;border-radius:18px;
    background:#1a6fd8;color:#fff;cursor:pointer;box-shadow:0 4px 14px rgba(26,111,216,.4);font-size:12px;display:none}
  /* 模型模式分段控制器 */
  #bgBody .mode-toggle{display:flex;gap:0;margin:0 0 8px;border:1px solid #d8dee8;border-radius:5px;overflow:hidden}
  #bgBody .mode-toggle input[type=radio]{display:none}
  #bgBody .mode-toggle label{flex:1;padding:5px 0;text-align:center;background:#f7f9fc;cursor:pointer;font-size:12px;color:#5a6675;border-right:1px solid #d8dee8;user-select:none}
  #bgBody .mode-toggle label:last-child{border-right:0}
  #bgBody .mode-toggle input[type=radio]:checked+label{background:#1a6fd8;color:#fff;font-weight:600}
  #bgBody .model-panel{display:none}
  #bgBody .model-panel.on{display:block}
  `;

  let panel, tabs, bodyEl, curTab = 'cfg', modelMode = 'single';

  function toggleMode(m) {
    modelMode = m;
    const singleEl = document.getElementById('c_single_panel');
    const multiEl = document.getElementById('c_multi_panel');
    if (singleEl) { if (m === 'single') singleEl.classList.add('on'); else singleEl.classList.remove('on'); }
    if (multiEl) { if (m === 'multi') multiEl.classList.add('on'); else multiEl.classList.remove('on'); }
  }

  function buildPanel() {
    const st = document.createElement('style');
    st.textContent = STYLE;
    document.documentElement.appendChild(st);

    panel = document.createElement('div');
    panel.id = 'bgPanel';
    panel.innerHTML =
      '<div id="bgHead"><b>BOSS 岗位筛选与打招呼助手</b>' +
      '<span class="mini" style="color:#9fc0ee;margin-left:4px">v' + VER + '</span>' +
      '<span id="bgStat" class="stat"></span>' +
      '<button id="bgClose" style="border:0;background:transparent;color:#fff;cursor:pointer;font-size:16px;margin-left:auto">×</button></div>' +
      '<div id="bgTabs">' +
      ['scout|筛选', 'cfg|设置', 'resume|简历', 'jobs|岗位', 'queue|队列', 'log|日志'].map((t) => {
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
    min.textContent = '筛选与打招呼助手';
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
    if (curTab === 'scout') renderScout();
    else if (curTab === 'cfg') renderCfg();
    else if (curTab === 'resume') renderResume();
    else if (curTab === 'jobs') renderJobsTab();
    else if (curTab === 'queue') renderQueue();
    else renderLog();
  }

  function selCount() { return selected().length; }
  // 这一轮到底在不在跑、暂停没暂停：执行者可能不是这一页，所以先看别人的心跳，再看自己内存里的 runner
  function isRunning() {
    if (runner.running) return true;
    const p = load(K.batch, null);
    return !!(spawning || planOwnerLive(p));
  }
  function isPaused() {
    const p = load(K.batch, null);
    if (planOwnerLive(p) && p.by !== pageToken) return !!p.pause;
    return runner.paused;
  }
  function updateStat() {
    const el = $('#bgStat', panel);
    if (!el) return;
    el.textContent = '岗位 ' + jobs.length + ' · 选中 ' + selCount() +
      ' · 详情 ' + Object.keys(details).length + ' · 今日 ' + stats.sent + '/' + cfg.maxPerDay;
    const p = readPlan();
    if (runner.running) {
      el.textContent += ' · 批量进行中（剩 ' + planLeft(p).length + (p && p.ids ? '/' + p.ids.length : '') + ' 条）';
    } else if (spawning) {
      el.textContent += ' · 正在交接给生成器标签页…';
    } else if (planOwnerLive(p)) {
      el.textContent += ' · ' + (p.role === 'exec' ? '生成器' : '另一个标签页') + '正在跑（剩 ' +
        planLeft(p).length + '/' + p.ids.length + ' 条' + (p.pause ? '，已暂停' : '') + '）';
    } else {
      const n = planLeft(p).length;
      if (n) el.textContent += ' · 可续跑 ' + n + ' 条';
    }
  }
  function updateRunnerUI() { updateStat(); }

  /* ---- 筛选页（v0.7.0 新增） ---- */
  // 轻量级实时更新：只更新进度数字和已收藏列表，不重建按钮/不重绑事件
  // 用于筛选循环内部，避免 renderScout() 频繁重建 DOM 导致按钮失效
  function updateScoutLiveUI() {
    const favorited = scoutProgress.favorited || [];
    const target = scoutCfg.targetCount;

    // 更新进度数字
    const progressFieldsets = bodyEl.querySelectorAll('fieldset');
    if (progressFieldsets[1]) {
      const miniDiv = progressFieldsets[1].querySelector('.mini');
      if (miniDiv) miniDiv.innerHTML = '已收藏: <b>' + favorited.length + '</b> / ' + target;
    }

    // 更新已收藏列表
    const listEl = bodyEl.querySelector('#s_list');
    if (listEl) {
      // 同时更新 legend 中的计数
      const listFieldset = listEl.closest('fieldset');
      if (listFieldset) {
        const legend = listFieldset.querySelector('legend');
        if (legend) legend.textContent = '已收藏岗位 (' + favorited.length + ')';
      }
      if (favorited.length === 0) {
        listEl.innerHTML = '<div class="mini">暂无</div>';
      } else {
        listEl.innerHTML = favorited.slice().reverse().map((j) =>
          '<div class="job"><div class="t"><b>' + esc(j.title || '(无标题)') + '</b>' +
          '<i>' + esc(j.salary || '') + ' · HR:' + esc(j.recruiterStatus || '未知') + ' · ' + esc((j.verdict || '').slice(0, 60)) + '</i>' +
          '<i class="mini">' + esc(new Date(j.ts).toLocaleString()) + '</i></div></div>'
        ).join('');
      }
    }
  }

  // 生成硬伤关键词区块的 HTML
  function renderHardInjuriesHTML() {
    const injuries = scoutCfg.hardInjuries || [];
    const enabled = scoutCfg.hardInjuriesEnabled !== false;
    const rows = injuries.map((word, i) =>
      '<div class="injury-row" data-idx="' + i + '">' +
      '<input class="injury-word" value="' + esc(word) + '" placeholder="硬伤词">' +
      '<button class="injury-del" data-idx="' + i + '" type="button">×</button>' +
      '</div>'
    ).join('');
    return '<fieldset class="collapsible-fieldset collapsed"><legend class="fieldset-legend-toggle"><span class="toggle-icon">▼</span> 硬伤关键词（命中任一直接跳过）</legend>' +
      '<div class="fieldset-content">' +
      '<label style="display:flex;align-items:center;gap:4px;font-size:12px;margin-bottom:6px">' +
      '<input type="checkbox" id="s_injury_enabled" style="flex:0 0 14px"' + (enabled ? ' checked' : '') + '> 启用硬伤关键词检查</label>' +
      '<div id="injury_list">' + rows + '</div>' +
      '<button class="act" id="injury_add" type="button" style="margin-top:4px">+ 添加硬伤词</button>' +
      '</div></fieldset>';
  }

  // 从 UI 收集硬伤关键词数据
  function collectHardInjuriesFromUI() {
    const rows = $$('#injury_list .injury-row', bodyEl);
    const words = [];
    rows.forEach((row) => {
      const word = ($('.injury-word', row).value || '').trim();
      if (word) words.push(word);
    });
    return words;
  }

  // 绑定硬伤关键词区块的动态事件（添加/删除）
  function bindHardInjuriesEvents() {
    $('#injury_add', bodyEl)?.addEventListener('click', () => {
      scoutCfg.hardInjuries = collectHardInjuriesFromUI();
      scoutCfg.hardInjuries.push('');
      renderScout();
    });
    $('#injury_list', bodyEl)?.addEventListener('click', (e) => {
      const btn = e.target.closest('.injury-del');
      if (!btn) return;
      scoutCfg.hardInjuries = collectHardInjuriesFromUI();
      const idx = Number(btn.dataset.idx);
      scoutCfg.hardInjuries.splice(idx, 1);
      renderScout();
    });
  }

  // 生成关键词加分区块的 HTML
  function renderBonusKeywordsHTML() {
    const keywords = scoutCfg.bonusKeywords || [];
    const threshold = scoutCfg.bonusThreshold || 0;
    const enabled = scoutCfg.bonusKeywordsEnabled !== false;
    const rows = keywords.map((item, i) => {
      const aliases = Array.isArray(item.aliases) ? item.aliases.join(', ') : '';
      const weight = item.weight || 1;
      return '<div class="kw-row" data-idx="' + i + '">' +
        '<input class="kw-name" value="' + esc(item.name || '') + '" placeholder="技能项名称">' +
        '<input class="kw-aliases" value="' + esc(aliases) + '" placeholder="别名（逗号分隔，可选）">' +
        '<input class="kw-weight" type="number" value="' + esc(String(weight)) + '" min="1" max="10" style="width:50px">' +
        '<button class="kw-del" data-idx="' + i + '" type="button">×</button>' +
        '</div>';
    }).join('');
    return '<fieldset class="collapsible-fieldset collapsed"><legend class="fieldset-legend-toggle"><span class="toggle-icon">▼</span> 关键词加分（非硬性，总分 ≥ 阈值才收藏）</legend>' +
      '<div class="fieldset-content">' +
      '<label style="display:flex;align-items:center;gap:4px;font-size:12px;margin-bottom:6px">' +
      '<input type="checkbox" id="s_bonus_enabled" style="flex:0 0 14px"' + (enabled ? ' checked' : '') + '> 启用关键词打分</label>' +
      '<div class="row" style="align-items:center;gap:8px;margin-bottom:6px">' +
      '<label style="font-size:12px">收藏阈值：</label>' +
      '<input id="s_bonus_threshold" type="number" value="' + esc(String(threshold)) + '" min="0" style="width:60px">' +
      '<span class="mini" style="color:#888">（0 = 跳过此关卡）</span>' +
      '</div>' +
      '<div id="kw_list">' + rows + '</div>' +
      '<button class="act" id="kw_add" type="button" style="margin-top:4px">+ 添加技能项</button>' +
      '</div></fieldset>';
  }

  // 从 UI 收集关键词数据
  function collectBonusKeywordsFromUI() {
    const rows = $$('#kw_list .kw-row', bodyEl);
    const keywords = [];
    rows.forEach((row) => {
      const name = ($('.kw-name', row).value || '').trim();
      if (!name) return; // 跳过空名称
      const aliasesRaw = ($('.kw-aliases', row).value || '').trim();
      const aliases = aliasesRaw ? aliasesRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];
      const weight = Math.max(1, Math.min(10, Number($('.kw-weight', row).value) || 1));
      keywords.push({ name: name, aliases: aliases, weight: weight });
    });
    return keywords;
  }

  // 绑定关键词区块的动态事件（添加/删除）
  function bindBonusKeywordsEvents() {
    $('#kw_add', bodyEl)?.addEventListener('click', () => {
      scoutCfg.bonusKeywords = collectBonusKeywordsFromUI();
      scoutCfg.bonusKeywords.push({ name: '', aliases: [], weight: 1 });
      renderScout();
    });
    // 删除按钮用事件委托（因为行是动态的）
    $('#kw_list', bodyEl)?.addEventListener('click', (e) => {
      const btn = e.target.closest('.kw-del');
      if (!btn) return;
      scoutCfg.bonusKeywords = collectBonusKeywordsFromUI();
      const idx = Number(btn.dataset.idx);
      scoutCfg.bonusKeywords.splice(idx, 1);
      renderScout();
    });
  }

  function renderScout() {
    const isRunning = scoutProgress.running;
    const isPaused = scoutProgress.paused;
    const favorited = scoutProgress.favorited || [];
    const target = scoutCfg.targetCount;

    bodyEl.innerHTML =
      '<fieldset><legend>岗位筛选与收藏</legend>' +
      '<div class="hint">在 BOSS 直聘实习列表页自动筛选并收藏符合要求的岗位。筛选口径：时长≤' + scoutCfg.maxMonths + '月、日薪中值≥' + scoutCfg.minDailySalary + '、出勤≤' + scoutCfg.maxDaysPerWeek + '天/周、招聘者活跃、无硬伤。</div>' +

      // 筛选参数
      '<div class="row">' +
      '<div><label>目标收藏数</label><input id="s_target" type="number" value="' + esc(target) + '"></div>' +
      '<div><label>最长实习(月)</label><input id="s_months" type="number" value="' + esc(scoutCfg.maxMonths) + '"></div>' +
      '<div><label>最低日薪(中值)</label><input id="s_salary" type="number" value="' + esc(scoutCfg.minDailySalary) + '"></div>' +
      '</div>' +
      '<div class="row">' +
      '<div><label>最多出勤(天/周)</label><input id="s_days" type="number" value="' + esc(scoutCfg.maxDaysPerWeek) + '"></div>' +
      '<div><label>最大滚动次数</label><input id="s_scroll" type="number" value="' + esc(scoutCfg.maxScrollTimes) + '"></div>' +
      '<div><label>操作间隔(ms)</label><input id="s_delay" type="number" value="' + esc(scoutCfg.delayBetweenActions) + '"></div>' +
      '</div>' +

      // HR 活跃度筛选
      '<label>HR 活跃度筛选（勾选的状态才通过）</label>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 12px">' +
      ['在线', '刚刚活跃', '今日活跃', '昨日活跃', '3日内活跃', '本周活跃'].map((s) =>
        '<label style="display:flex;align-items:center;gap:4px;font-size:12px;white-space:nowrap"><input type="checkbox" class="s_hr_status" value="' + s + '" style="flex:0 0 14px"' +
        ((scoutCfg.hrActiveStatus || []).includes(s) ? ' checked' : '') + '> ' + s + '</label>'
      ).join('') +
      '</div>' +

      // 硬伤关键词
      renderHardInjuriesHTML() +

      // 关键词加分
      renderBonusKeywordsHTML() +

      // 控制按钮
      '<div class="btns">' +
      '<button class="act pri" id="s_save"' + (isRunning ? ' disabled' : '') + '>保存配置</button>' +
      '<button class="act pri" id="s_start"' + (isRunning ? ' disabled' : '') + '>开始筛选当前页</button>' +
      (isRunning ? '<button class="act" id="s_pause_resume">' + (scoutProgress.paused ? '继续' : '暂停') + '</button>' : '') +
      (isRunning ? '<button class="act" id="s_stop">停止</button>' : '') +
      '</div>' +
      '</fieldset>' +

      // 进度显示
      '<fieldset><legend>筛选进度</legend>' +
      '<div class="row">' +
      '<div class="mini">已收藏: <b>' + favorited.length + '</b> / ' + target + '</div>' +
      '<div class="mini">状态: ' + (isRunning ? (isPaused ? '<span style="color:#b26a00">已暂停</span>' : '<span style="color:#1c8a45">运行中</span>') : '<span>空闲</span>') + '</div>' +
      '</div>' +
      '<div class="btns">' +
      '<button class="act" id="s_clear">清空进度</button>' +
      '<button class="act" id="s_export">导出报告</button>' +
      '</div>' +
      '</fieldset>' +

      // 已收藏列表
      '<fieldset><legend>已收藏岗位 (' + favorited.length + ')</legend>' +
      '<div id="s_list" style="max-height:200px;overflow:auto">' +
      (favorited.length === 0 ? '<div class="mini">暂无</div>' :
        favorited.slice().reverse().map((j) =>
          '<div class="job"><div class="t"><b>' + esc(j.title || '(无标题)') + '</b>' +
          '<i>' + esc(j.salary || '') + ' · HR:' + esc(j.recruiterStatus || '未知') + ' · ' + esc((j.verdict || '').slice(0, 60)) + '</i>' +
          '<i class="mini">' + esc(new Date(j.ts).toLocaleString()) + '</i></div></div>'
        ).join('')) +
      '</div>' +
      '</fieldset>';

    // 绑定事件
    bindHardInjuriesEvents();
    bindBonusKeywordsEvents();

    // 折叠/展开事件
    $$('.collapsible-fieldset .fieldset-legend-toggle', bodyEl).forEach((legend) => {
      legend.addEventListener('click', (e) => {
        e.preventDefault();
        const fieldset = legend.closest('.collapsible-fieldset');
        if (fieldset) fieldset.classList.toggle('collapsed');
      });
    });

    $('#s_save', bodyEl)?.addEventListener('click', () => {
      scoutCfg.targetCount = Math.max(1, Number($('#s_target', bodyEl).value) || 20);
      scoutCfg.maxMonths = Math.max(1, Number($('#s_months', bodyEl).value) || 3);
      scoutCfg.minDailySalary = Math.max(0, Number($('#s_salary', bodyEl).value) || 200);
      scoutCfg.maxDaysPerWeek = Math.max(1, Number($('#s_days', bodyEl).value) || 5);
      scoutCfg.maxScrollTimes = Math.max(1, Number($('#s_scroll', bodyEl).value) || 10);
      scoutCfg.delayBetweenActions = Math.max(500, Number($('#s_delay', bodyEl).value) || 1500);
      // 保存 HR 活跃度筛选
      const hrStatusCheckboxes = $$('.s_hr_status', bodyEl);
      scoutCfg.hrActiveStatus = hrStatusCheckboxes.filter((cb) => cb.checked).map((cb) => cb.value);
      // 保存硬伤关键词
      scoutCfg.hardInjuries = collectHardInjuriesFromUI();
      const injuryEnabledCb = $('#s_injury_enabled', bodyEl);
      scoutCfg.hardInjuriesEnabled = injuryEnabledCb ? injuryEnabledCb.checked : true;
      // 保存关键词加分配置
      scoutCfg.bonusKeywords = collectBonusKeywordsFromUI();
      scoutCfg.bonusThreshold = Math.max(0, Number($('#s_bonus_threshold', bodyEl).value) || 0);
      const bonusEnabledCb = $('#s_bonus_enabled', bodyEl);
      scoutCfg.bonusKeywordsEnabled = bonusEnabledCb ? bonusEnabledCb.checked : true;
      saveScoutCfg();
      log('✓ 筛选配置已保存');
      renderScout();
    });

    $('#s_start', bodyEl)?.addEventListener('click', async () => {
      if (scoutProgress.running) { log('· 筛选已在运行'); return; }
      scoutProgress.running = true;
      scoutProgress.paused = false;
      scoutProgress.currentIndex = 0;
      scoutProgress.currentJobId = '';
      saveScoutProgress();
      renderScout(); // 立即显示暂停/停止按钮
      log('▶ 开始筛选当前页...');
      const result = await runScoutInCurrentPage(0);
      // 筛选完成或停止时重置状态
      if (!scoutProgress.paused) {
        scoutProgress.running = false;
        scoutProgress.paused = false;
        scoutProgress.currentIndex = 0;
        scoutProgress.currentJobId = '';
      }
      saveScoutProgress();
      if (result.error) log('✗ 错误: ' + result.error);
      else log('▶ 筛选结束：本轮收藏 ' + result.favorited.length + ' 个，跳过 ' + result.skipped.length + ' 个');
      renderScout();
    });

    // 暂停/继续按钮：切换显示，暂停时保存位置，继续时从标记处恢复
    $('#s_pause_resume', bodyEl)?.addEventListener('click', async () => {
      if (scoutProgress.paused) {
        // 继续：从上次位置继续
        scoutProgress.paused = false;
        saveScoutProgress();
        renderScout(); // 立即切换按钮文字为"暂停"
        const resumeIndex = scoutProgress.currentIndex || 0;
        log('▶ 继续筛选，从第 ' + (resumeIndex + 1) + ' 个岗位开始...');
        const result = await runScoutInCurrentPage(resumeIndex);
        // 筛选完成或停止时重置状态
        if (!scoutProgress.paused) {
          scoutProgress.running = false;
          scoutProgress.paused = false;
          scoutProgress.currentIndex = 0;
          scoutProgress.currentJobId = '';
        }
        saveScoutProgress();
        if (result.error) log('✗ 错误: ' + result.error);
        else log('▶ 筛选结束：本轮收藏 ' + result.favorited.length + ' 个，跳过 ' + result.skipped.length + ' 个');
        renderScout();
      } else {
        // 暂停：保存位置，按钮变"继续"
        scoutProgress.paused = true;
        saveScoutProgress();
        log('· 筛选已暂停，已记录位置：第 ' + (scoutProgress.currentIndex + 1) + ' 个岗位');
        renderScout();
      }
    });

    // 停止按钮：直接结束筛选，按钮消失，无后续操作
    $('#s_stop', bodyEl)?.addEventListener('click', () => {
      scoutProgress.running = false;
      scoutProgress.paused = false;
      scoutProgress.currentIndex = 0;
      scoutProgress.currentJobId = '';
      saveScoutProgress();
      log('· 筛选已停止');
      renderScout();
    });

    $('#s_clear', bodyEl)?.addEventListener('click', () => {
      if (!confirm('确定清空所有筛选进度和报告？')) return;
      scoutProgress = { favorited: [], skipped: [], running: false, paused: false, currentIndex: 0, currentJobId: '' };
      scoutReport = [];
      saveScoutProgress();
      saveScoutReport();
      log('· 筛选进度已清空');
      renderScout();
    });

    $('#s_export', bodyEl)?.addEventListener('click', () => {
      const report = {
        exported: new Date().toISOString(),
        config: scoutCfg,
        progress: scoutProgress,
        report: scoutReport
      };
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'boss-scout-report-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      URL.revokeObjectURL(url);
      log('· 报告已导出');
    });
  }

  /* ---- 设置页 ---- */
  function renderCfg() {
    bodyEl.innerHTML =
      // 顶部：模式选择器（2选1）
      '<div class="mode-toggle">' +
      '<input type="radio" name="model_mode" id="mm_single" value="single" ' + (modelMode !== 'multi' ? 'checked' : '') + '>' +
      '<label for="mm_single">单模型</label>' +
      '<input type="radio" name="model_mode" id="mm_multi" value="multi" ' + (modelMode === 'multi' ? 'checked' : '') + '>' +
      '<label for="mm_multi">多模型并行</label>' +
      '</div>' +

      // 单模型面板：完整 API 配置
      '<div id="c_single_panel" class="model-panel' + (modelMode !== 'multi' ? ' on' : '') + '">' +
      '<fieldset><legend>大模型接口（OpenAI 兼容）</legend>' +
      '<label>API Base</label><input id="c_base" value="' + esc(cfg.apiBase) + '" placeholder="https://api.xxx.com/v1">' +
      '<label>API Key（仅存本机，不会写进日志）</label>' +
      '<div class="row"><input id="c_key" type="password" value="' + esc(cfg.apiKey) + '" placeholder="sk-...">' +
      '<button class="act" id="c_eye" style="flex:0 0 56px">显示</button></div>' +
      '<label>Model</label><input id="c_model" value="' + esc(cfg.model) + '">' +
      '<div class="row"><div><label>temperature</label><input id="c_temp" value="' + esc(cfg.temperature) + '"></div>' +
      '<div><label>max_tokens</label><input id="c_mt" value="' + esc(cfg.maxTokens) + '"></div>' +
      '<div><label>并发数(1-8)</label><input id="c_conc" value="' + esc(cfg.genConcurrency) + '"></div></div>' +
      '<div class="hint">并发只加速生成，发送仍逐条排队。遇 429 限流就调回 1。</div>' +
      '<div class="btns"><button class="act pri" id="c_save">保存设置</button><button class="act" id="c_test">连通测试</button></div>' +
      '<div class="hint">Key 不要上传公开仓库；换电脑前手动备份。</div>' +
      '</fieldset>' +
      '</div>' +

      // 多模型面板：多模型列表配置
      '<div id="c_multi_panel" class="model-panel' + (modelMode === 'multi' ? ' on' : '') + '">' +
      '<fieldset><legend>多模型并行配置</legend>' +
      '<div class="hint">批量时岗位按哈希分配到不同模型，各跑各的互不干扰。</div>' +
      '<div id="c_models_list" style="margin-top:4px"></div>' +
      '<div class="btns" style="margin-top:4px"><button class="act" id="c_add_model">+ 添加模型</button><button class="act pri" id="c_save_models">保存多模型配置</button></div>' +
      '</fieldset>' +
      '</div>' +

      '<fieldset><legend>发送策略</legend>' +
      '<div class="row" style="margin-bottom:4px"><label class="mini" style="margin:0"><input type="radio" name="mode" id="m_semi" ' + (!cfg.autoSend ? 'checked' : '') + ' style="width:auto"> 半自动：只生成，我点发送</label>' +
      '<label class="mini" style="margin:0"><input type="radio" name="mode" id="m_auto" ' + (cfg.autoSend ? 'checked' : '') + ' style="width:auto"> 全自动：生成后自动发送</label></div>' +
      '<div class="hint danger">全自动有封号风险，先小量验证。</div>' +
      '<div class="row"><div><label>最小间隔(ms)</label><input id="c_dmin" value="' + esc(cfg.delayMin) + '"></div>' +
      '<div><label>最大间隔(ms)</label><input id="c_dmax" value="' + esc(cfg.delayMax) + '"></div>' +
      '<div><label>每日上限</label><input id="c_max" value="' + esc(cfg.maxPerDay) + '"></div></div>' +
      '<div class="btns"><button class="act" id="c_save2">保存策略</button></div>' +
      '</fieldset>' +

      '<fieldset><legend>提示词（{{RESUME}} / {{JOB}} 自动替换）</legend>' +
      '<label>System</label><textarea id="c_sys" rows="8">' + esc(cfg.systemPrompt) + '</textarea>' +
      '<label>User</label><textarea id="c_usr" rows="6">' + esc(cfg.userPrompt) + '</textarea>' +
      '<div class="btns"><button class="act" id="c_save3">保存提示词</button><button class="act" id="c_reset">恢复默认</button></div>' +
      '</fieldset>';

    const g = (id) => $('#' + id, bodyEl);
    $('#c_eye', bodyEl).addEventListener('click', () => {
      const i = g('c_key'); const show = i.type === 'password';
      i.type = show ? 'text' : 'password'; $('#c_eye', bodyEl).textContent = show ? '隐藏' : '显示';
    });
    // 模式切换（radio 2选1）
    $$('input[name=model_mode]', bodyEl).forEach((r) => r.addEventListener('change', () => toggleMode(r.value)));
    const collect = () => {
      cfg.apiBase = cleanApiBase(g('c_base').value) || DEFAULTS.apiBase;
      cfg.apiKey = cleanCfgStr(g('c_key').value);
      cfg.model = cleanCfgStr(g('c_model').value);
      cfg.temperature = Number(g('c_temp').value) || 0.8;
      cfg.maxTokens = Number(g('c_mt').value) || 400;
      cfg.genConcurrency = Math.min(8, Math.max(1, Math.round(Number(g('c_conc').value) || 3)));
    };
    $('#c_save', bodyEl).addEventListener('click', () => { collect(); saveCfg(); log('设置已保存（Key ' + (cfg.apiKey ? '长度 ' + cfg.apiKey.length : '空') + '，并发生成 ' + cfg.genConcurrency + ' 路）'); });
    $('#c_save2', bodyEl).addEventListener('click', () => {
      collect();
      cfg.autoSend = $('#m_auto', bodyEl).checked;
      cfg.delayMin = Math.max(2000, Number(g('c_dmin').value) || 9000);
      cfg.delayMax = Math.max(cfg.delayMin, Number(g('c_dmax').value) || 22000);
      cfg.maxPerDay = Math.max(1, Number(g('c_max').value) || 20);
      if (cfg.autoSend && !cfg.autoOpenChat) {
        cfg.autoOpenChat = true;
        log('· 已同时打开「自动点击立即沟通」：全自动必须靠它打开沟通页，否则每条都会失败');
      }
      saveCfg(); log('策略已保存：' + (cfg.autoSend ? '全自动' : '半自动') + '，发送入口' + (cfg.sendViaList ? '列表卡片' : '岗位详情页'));
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

    function renderModelsList() {
      const listEl = $('#c_models_list', bodyEl);
      if (!listEl) return;
      const models = cfg.models || [];
      if (models.length === 0) {
        listEl.innerHTML = '<div class="hint">暂无配置，点「+ 添加模型」开始</div>';
        return;
      }
      let html = '';
      models.forEach((m, i) => {
        html += '<fieldset style="margin-bottom:6px;padding:6px 8px;border:1px solid #ddd;border-radius:4px">' +
          '<legend style="font-weight:bold;padding:0 4px;font-size:11.5px">并行模型' + (i + 1) + ' <button class="del-btn" data-i="' + i + '" style="padding:1px 7px;font-size:11px;background:#f44;color:#fff;border:none;border-radius:3px;cursor:pointer;margin-left:6px">删除</button></legend>' +
          '<label>API Base</label><input class="m_base" value="' + esc(m.apiBase) + '" placeholder="https://api.xxx.com/v1">' +
          '<label>API Key</label><input class="m_key" type="password" value="' + esc(m.apiKey) + '" placeholder="sk-...">' +
          '<label>Model</label><input class="m_model" value="' + esc(m.model) + '" placeholder="qwen-max">' +
          '</fieldset>';
      });
      listEl.innerHTML = html;
    }

    $('#c_models_list', bodyEl).addEventListener('click', (e) => {
      if (e.target.classList.contains('del-btn')) {
        const idx = parseInt(e.target.dataset.i);
        if (!confirm('确定删除这个模型？')) return;
        cfg.models.splice(idx, 1);
        renderModelsList();
      }
    });

    $('#c_add_model', bodyEl).addEventListener('click', () => {
      cfg.models.push({ apiBase: cfg.apiBase || DEFAULTS.apiBase, apiKey: '', model: '', _label: '并行模型' + (cfg.models.length + 1) });
      renderModelsList();
    });

    $('#c_save_models', bodyEl).addEventListener('click', () => {
      const fieldsets = Array.from(document.querySelectorAll('#c_models_list fieldset'));
      cfg.models = fieldsets.map((fs, i) => {
        const base = cleanApiBase(fs.querySelector('.m_base').value);
        const key = cleanCfgStr(fs.querySelector('.m_key').value);
        const model = cleanCfgStr(fs.querySelector('.m_model').value);
        return { apiBase: base, apiKey: key, model: model, _label: '并行模型' + (i + 1) };
      }).filter(m => m.apiKey && m.model);
      saveCfg();
      log('多模型配置已保存（共 ' + cfg.models.length + ' 个模型）');
      renderModelsList();
    });

    renderModelsList();
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
      '<div class="btns"><button class="act pri" id="j_here">抓当前页</button>' +
      '<button class="act" id="j_pages">自动翻页抓</button><input id="j_np" value="3" style="flex:0 0 54px">' +
      '<button class="act" id="j_detail">抓选中岗位详情</button></div>' +
      '<div class="btns"><button class="act" id="j_all">全选/取消</button><button class="act warn" id="j_clear">清空列表</button></div>' +
      '</fieldset><div id="j_list"></div>';

    $('#j_here', bodyEl).addEventListener('click', async () => { scrapeCurrentPage(); await autoDetailsAfterScrape(); });
    $('#j_pages', bodyEl).addEventListener('click', async () => {
      await scrapeWithPagination(Math.min(20, Number($('#j_np', bodyEl).value) || 3));
      await autoDetailsAfterScrape();
    });
    $('#j_detail', bodyEl).addEventListener('click', () => fetchDetails(selected()));
    $('#j_clear', bodyEl).addEventListener('click', () => {
      const n = Object.keys(drafts).length;
      if (!confirm('清空已抓的岗位、详情和 ' + n + ' 条草稿缓存？')) return;
      jobs = []; details = {}; drafts = {};
      Object.keys(states).forEach((k) => delete states[k]);
      save(K.jobs, jobs); save(K.details, details); save(K.drafts, drafts);
      // 列表都清空了，「上一轮还剩几条」自然也不再成立：不清掉的话队列页还会挂着「继续上次批量」
      // 先在计划里留一条「停」，正在跑的生成器下一次心跳就会收手（不然它还在对着已经不存在的岗位烧 token）
      const p0 = load(K.batch, null);
      if (p0 && p0.by && p0.by !== pageToken) { p0.stop = Date.now(); save(K.batch, p0); }
      stopBeat();
      try { GM_deleteValue(K.batch); } catch (e) {}
      try { GM_deleteValue(K.exec); } catch (e) {}   // 没认领的交接单也一起作废，别再凭空开一个生成器
      const swept = sweepSentCreds();   // 「已发出」凭证跟着草稿一起清，不然重抓同一批会被拦住发不出去
      renderJobsTab();
      log('岗位列表、详情、草稿缓存已全部清空' + (swept ? '（顺带清掉 ' + swept + ' 条「已发出」凭证，重抓同一批岗位可以再发）' : ''));
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
    const has = hasDetail(id) ? '有详情' : '缺 JD 不生成';
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

  /* -------------------------- 队列里单条发送（两个入口共用） ------------------
   * 行内「发送」按钮和全自动下的「生成并发送」都走这一条。这段以前只长在按钮的点击
   * 回调里，所以「生成完自动接着发」想复用只能再去模拟点一次按钮 —— 那就又回到
   * 「选了全自动还得自己点发送」那个现场。抽出来之后两条路对模式的解释只有一份。
   */
  async function sendOne(id) {
    // 同一条岗位同一时刻只允许一路在发。批量消费者和行内「发送/生成并发送」是两条入口，
    // 而 drafts[id].sent 要到发成功之后才置位 —— 两路同时在飞时谁都读不到对方的标记，
    // 于是同一个 HR 会收到两遍同样的话。v0.5.2 的并发生成让「生成完那一瞬间两路都扑上来」
    // 更容易发生，所以这道闩必须有（去掉它，回归里那条断言会红）。
    if (sendBusy[id]) { log('· 「' + jobTitle(id) + '」已经有一路在发了，这里不重复触发'); renderQueue(); return; }
    sendBusy[id] = true;
    try { await sendNow(id); } finally { delete sendBusy[id]; }
  }

  async function sendNow(id) {
    syncFromStorage();   // 草稿可能是另一个标签页刚写的：先对一次账，别对着自己那份旧快照说「还没有草稿」
    if (!drafts[id]) { log('· 「' + jobTitle(id) + '」还没有草稿，先生成'); return; }
    if (drafts[id].sent) { log('· 「' + jobTitle(id) + '」已发送过，不重复发送'); renderQueue(); return; }
    // 上一轮跑到一半页面被跳转销毁时，「已发送」这个标记是面板写在自己草稿上的 —— 它没了，
    // 但真正把话发出去的那个标签页留下了 bgSent:<岗位id> 这条持久凭证。认这条凭证，
    // 否则续跑就是对着同一个 HR 再发一遍同样的招呼语。
    if (alreadySent(id)) {
      drafts[id].sent = true; drafts[id].sentAt = Date.now();
      stats.sent++; saveDrafts([id]); saveStats();
      log('· 「' + jobTitle(id) + '」在上一页就已经发出去了（补记为已发送，不再重复发）');
      renderQueue(); return;
    }
    if (isDraftStale(id)) { log('· 「' + jobTitle(id) + '」的草稿已过期（简历/岗位/提示词变过），先重新生成再发'); renderQueue(); return; }
    if (cfg.autoSend && Number(cfg.maxPerDay) - stats.sent <= 0) {
      log('· 已达今日发送上限 ' + cfg.maxPerDay + '，这条不自动发送（要接着发就去「日志」页重置今日计数）');
      renderQueue();
      return;
    }
    const job = jobs.find((j) => j.id === id) || {};
    setJobState(id, '发送中');
    let r;
    if (cfg.autoSend) {
      // 全自动：和「开始批量」走同一条路——另开标签页，在那边开沟通、填、发，
      // 不发当前页。旧版这里无视模式、只在当前页找输入框，于是设了全自动还得自己开沟通页。
      if (!/^https?:/.test(job.url || '')) r = { ok: false, why: '没有岗位链接，无法开标签页发送' };
      else {
        log('· 全自动：开标签页发送「' + jobTitle(id) + '」（' + (cfg.sendViaList ? '列表卡片入口' : '岗位详情页入口') + '）');
        r = await dispatchSend(job, drafts[id].text);
      }
    } else {
      // 半自动：你现在就站在沟通页 → 当场填并发；不在 → 另开一个标签页走到这个岗位的
      // 沟通页，把话填好就停手，最后那一下「发送」留给你点。旧版这里只会甩一句
      // 「请先自己打开沟通页再点发送」，等于把最麻烦的一步推回给用户。
      r = await sendMessage(drafts[id].text, id);
      if (r.noComposer && (/^https?:/.test(job.url || '') || /^https?:/.test(job.listUrl || ''))) {
        log('· 半自动：这一页不在沟通页，另开标签页走到这个岗位的沟通页只填不发');
        r = await dispatchSend(job, drafts[id].text, true);
      } else if (r.noComposer) {
        r.why = '这一页没有聊天输入框，这条岗位又没有可打开的链接，只能你自己进沟通页再粘贴（复制按钮在草稿旁边）';
      }
    }
    if (r.ok) {
      drafts[id].sent = true; drafts[id].sentAt = Date.now();
      stats.sent++; saveDrafts([id]); saveStats();
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
      setJobState(id, '发送失败');
      log('✗ 发送未确认：「' + jobTitle(id) + '」' + r.why);
    }
    renderQueue();
  }

  /* ---- 队列页 ---- */
  function renderQueue() {
    if (curTab !== 'queue') { updateStat(); return; }
    bodyEl.innerHTML =
      '<fieldset><legend>生成与发送</legend>' +
      '<div class="btns"><button class="act pri" id="q_run">' + (isRunning() ? '停止批量' : '开始批量') + '</button>' +
      '<button class="act" id="q_pause">' + (isPaused() ? '继续' : '暂停') + '</button>' +
      '<span class="mini" style="flex:0 0 auto">' + (cfg.autoSend ? '全自动' : '半自动') + '</span>' +
      (isRunning() || !planLeft(readPlan()).length ? '' :
        '<button class="act pri" id="q_resume">继续上次批量（剩 ' + planLeft(readPlan()).length + ' 条）</button>') +
      '</div>' +
      '</fieldset><div id="q_list"></div>';

    $('#q_run', bodyEl).addEventListener('click', () => {
      if (runner.running) {
        runner.running = false;
        finishPlan(batchTargets);           // 立刻挂出「继续上次批量（剩 N 条）」，不等在飞的那条回包
        log('已请求停止');
        updateStat(); if (curTab === 'queue') renderQueue();
        return;
      }
      if (spawning) { log('· 生成器正在起来的路上（交接最多等 25 秒），现在停还不算数：等它接手后再按一次'); return; }
      const p = readPlan();
      // 跑的是别的标签页（生成器）：这一页不接管，只把「停止」写进计划，由执行者自己去认
      if (planOwnerLive(p)) { signalOwner('stop', Date.now()); renderQueue(); return; }
      const ids = selected().map((j) => j.id);
      if (!ids.length) { log('先在「岗位」页勾选要处理的岗位'); return; }
      startBatch(ids);
    });
    $('#q_pause', bodyEl).addEventListener('click', () => {
      const p = readPlan();
      if (planOwnerLive(p)) { signalOwner('pause', !p.pause); renderQueue(); return; }
      runner.paused = !runner.paused;
      const q = load(K.batch, null);
      if (q && q.by === pageToken) { q.pause = runner.paused; save(K.batch, q); }   // 让别的页面按钮上也是「继续」
      renderQueue(); log(runner.paused ? '已暂停' : '已继续');
    });
    const rb = $('#q_resume', bodyEl);
    if (rb) rb.addEventListener('click', () => {
      syncFromStorage();
      const left = planLeft(readPlan());
      if (!left.length) { log('· 没有可续跑的岗位了'); renderQueue(); return; }
      log('· 接着上一轮跑，剩 ' + left.length + ' 条');
      startBatch(left);
    });

    const list = $('#q_list', bodyEl);
    const sel = selected();
    if (!sel.length) { list.innerHTML = '<div class="mini">队列为空（去「岗位」页勾选）</div>'; return; }
    list.innerHTML = sel.map((j) => {
      const d = drafts[j.id];
      const stale = !!d && !d.sent && isDraftStale(j.id);   // 已发送的不催过期：反正不会再发第二次
      // 没 JD 的岗位不给「生成」按钮 —— 给了点了也只会拿到一句报错。这里直接换成
      // 「补抓详情并生成」：一条点击把后台开标签抓 JD、回收、再写草稿串起来，
      // 拦死但不把人堵死。连详情页链接都没有的（站点改版才会这样）只能明说。
      const jd = hasDetail(j.id);
      const canFetch = /^https?:/.test(j.url || '');
      // 全自动下这颗按钮点下去就是「生成 + 发出」，按钮上写清楚（v0.5.1）：
      // 以前只写「生成」，用户按设置页那句「全自动：生成后自动开沟通页发送」去理解，
      // 结果还得自己在同一行再找「发送」，等于多一步确认。
      const tail = cfg.autoSend ? '并发送' : '';
      const genBtn = jd
        ? '<button class="act gen">' + (d ? '重新生成' + tail : '生成' + tail) + '</button>'
        : canFetch
          ? '<button class="act fgen">' + (d ? '补抓详情后重新生成' + tail : (cfg.autoSend ? '补抓详情后生成并发送' : '补抓详情并生成')) + '</button>'
          : '<button class="act ngen">缺 JD 不能生成</button>';
      return '<div class="job" data-id="' + esc(j.id) + '"><div class="t"><b>' + esc(j.title) + '</b>' +
        '<i>' + esc([j.company, j.salary].filter(Boolean).join(' · ')) + '</i>' +
        (d ? '<div class="draft' + (stale ? ' stale' : '') + '">' + esc(d.text) + '</div>' : '') +
        (stale ? '<div class="mini warn">这条草稿是按旧简历/旧详情生成的，已失效，请重新生成后再发送</div>' : '') +
        (jd ? '' : '<div class="mini warn">这条还没抓到岗位详情（JD）。只有标题和薪资时模型只能瞎编，所以不给生成' +
          (canFetch ? '——点下面「补抓详情并生成」，脚本后台打开这个岗位的详情页抓回来再写' : '——而这条岗位连详情页链接都没抓到，只能你自己进页面看岗位描述') + '</div>') +
        '<div class="btns">' + genBtn +
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
      const genB = $('.gen, .fgen, .ngen', row);
      if (genB) genB.addEventListener('click', async (e) => {
        const btn = e.currentTarget || e.target;
        if (btn.classList.contains('ngen')) {
          log('· 「' + jobTitle(id) + '」没抓到详情页链接，拿不到 JD，不给生成');
          return;
        }
        if (btn.classList.contains('fgen')) {
          btn.textContent = '抓详情中';
          await fetchDetails([id]);
          // fetchDetails 里会重画队列，这一行/按钮已经脱离文档了，后面一律按 id 重新找
          if (!hasDetail(id)) {
            log('✗ 「' + jobTitle(id) + '」的 JD 还是没抓到（标签页没开起来 / 详情页结构变了 / 需要重新登录），依然不给生成');
            renderQueue();
            return;
          }
        }
        const live = queueRow(id);
        const lb = live && $('.gen, .fgen', live);
        if (lb) lb.textContent = '生成中';
        // 单条手点「生成」：用第一个模型（cfg.models[0]），保证同一条岗位重跑时永远走同一个模型。
        generateShared(id, cfg.models[0]).then(async (t) => {
          log('已生成：' + t.slice(0, 24) + '...');
          renderQueue();
          // 全自动：生成完直接接着发出去，不用再点第二次（半自动仍然停在草稿上等你审）。
          // 旧版这里只生成，于是设置里那句「全自动：生成后自动开沟通页发送」在队列单条上
          // 根本不成立 —— 用户只能自己再去找那颗「发送」。
          if (cfg.autoSend) await sendOne(id);
        }).catch((er) => { log('✗ 生成失败：' + er.message); renderQueue(); });
      });
      const s = $('button.snd', row);   // 只认按钮：状态徽章以前也叫 .snd，点徽章会触发重发
      if (s) s.addEventListener('click', async (e) => {
        e.target.textContent = '发送中';
        await sendOne(id);
      });
      const c = $('.cp', row);
      if (c) c.addEventListener('click', () => {
        navigator.clipboard.writeText(drafts[id].text).then(() => log('已复制到剪贴板'), () => log('剪贴板不可用，请手动选中文本复制'));
      });
    });
  }

  const states = {};
  // 队列里按 id 找当前那一行：dataset.id 比 CSS 属性选择器稳（id 里可能有 | 之类的字符）
  function queueRow(id) {
    return $$('#q_list .job').filter((r) => r.dataset.id === id)[0] || null;
  }
  function stateOf(id) {
    if (drafts[id] && drafts[id].sent) return '已发送';
    // 执行者在别的标签页（生成器）里正在写这条：本页内存里的 states 一定没有它，
    // 只能看计划上公布的那份 in-flight 名单。这条徽章就是用户判断「还在跑吗」的唯一依据。
    if (!runner.running && remoteGen(id)) return '生成中';
    if (drafts[id] && isDraftStale(id)) return '草稿已过期';
    return states[id] || (drafts[id] ? '已生成' : '待处理');
  }
  function remoteGen(id) {
    const p = load(K.batch, null);
    return !!(p && planOwnerLive(p) && (p.gen || []).indexOf(id) >= 0);
  }
  function stateClass(id) {
    const s = stateOf(id);
    if (s === '已发送') return 'sent';   // 别用 'snd'：那是「发送」按钮的 class，撞了会让状态徽章变成可点的发送键
    if (s === '草稿已过期') return 'stale';
    if (s === '出错' || s === '发送失败' || s === '缺 JD 已跳过') return 'err';
    if (s === '生成中' || s === '发送中' || s === '待确认' || s === '已填待确认') return 'run';
    return '';
  }
  function setJobState(id, s) { states[id] = s; renderQueue(); }

  /* ---- 日志页 ---- */
  // 生成器那一页的日志写在另一个键里（两边各写各的，谁也不会把对方那 200 行盖掉），这里只读最近 60 行
  function execLogTail() {
    const l = load(K.execLog, null);
    return Array.isArray(l) ? l.slice(-60).join('\n') : '';
  }
  function renderLog() {
    const exLog = execLogTail();
    bodyEl.innerHTML =
      '<fieldset><legend>运行日志</legend>' +
      '<textarea id="bgLog" rows="14" readonly placeholder="日志会出现在这里">' + esc(logBuf.join('\n')) + '</textarea>' +
      '<div class="btns"><button class="act" id="l_clear">清空</button><button class="act" id="l_copy">复制全部</button><button class="act" id="l_reset">重置今日计数</button></div>' +
      '<div class="hint">日志不会打印 API Key。切标签、关面板都不会丢；整页跳转后最近 200 行也会从油猴存储里捞回来（脚本随页面重启，历史留着）。</div></fieldset>' +
      (exLog || planOwnerLive(readPlan())
        ? '<fieldset><legend>生成器标签页的日志' + (isRunning() ? '（正在跑）' : '') + '</legend>' +
          '<textarea id="bgExecLog" rows="8" readonly placeholder="这一轮没走过生成器">' + esc(exLog) + '</textarea>' +
          '<div class="hint">上面那份是你正在看的这一页写的，这一份是后台「生成器」标签页写的（每两秒随心跳刷出来）。' +
          '想看更细的，切到那个标题写着「招呼语生成器」的标签页按 F12 看控制台。</div>' +
          '<div class="btns"><button class="act" id="l_copyex">复制生成器日志</button></div></fieldset>'
        : '');
    const box = $('#bgLog', bodyEl);
    box.scrollTop = box.scrollHeight;
    $('#l_clear', bodyEl).addEventListener('click', () => { logBuf.length = 0; box.value = ''; $('#bgFoot').textContent = '已清空'; saveLog(true); });
    $('#l_copy', bodyEl).addEventListener('click', () => {
      box.select();
      try { document.execCommand('copy'); log('日志已复制到剪贴板'); }
      catch (e) { navigator.clipboard.writeText(logBuf.join('\n')).then(() => log('日志已复制'), () => log('复制失败，请手动全选')); }
    });
    const exBox = $('#bgExecLog', bodyEl);
    if (exBox) {
      exBox.scrollTop = exBox.scrollHeight;
      $('#l_copyex', bodyEl).addEventListener('click', () => {
        const t = exBox.value;
        try { exBox.select(); document.execCommand('copy'); log('生成器日志已复制到剪贴板'); }
        catch (e) { navigator.clipboard.writeText(t).then(() => log('生成器日志已复制'), () => log('复制失败，请手动全选')); }
      });
    }
    // 这是第三处「故意整块盖存储」的地方（另两处是清空列表、重置全部本地数据）。盖之前要盖个时间戳：
    // 不然另一页还开着的旧标签页一回写就把刚清掉的 4/20 抬回来，重置白按（见 saveStats）。
    $('#l_reset', bodyEl).addEventListener('click', () => {
      stats = { day: today(), sent: 0, generated: 0, resetAt: Date.now() };
      save(K.stats, stats);
      updateStat(); log('今日计数已重置');
    });
  }

  /* ---------------------------------------------------------------- 启动 */

  GM_registerMenuCommand('打开/显示助手面板', () => {
    if (!panel) buildPanel();
    panel.style.display = 'flex';
    const min = $('#bgMin'); if (min) min.style.display = 'none';
  });
  GM_registerMenuCommand('重置全部本地数据', () => {
    [K.cfg, K.resume, K.jobs, K.details, K.drafts, K.stats, K.pending, K.batch, K.logbuf, K.exec, K.execLog,
     K.scoutCfg, K.scoutProgress, K.scoutReport].forEach((k) => GM_deleteValue(k));
    const swept = sweepSentCreds();   // 每条岗位的「已发出」凭证是一条一个键，按前缀扫掉
    log('已清空' + (swept ? '（含 ' + swept + ' 条「已发出」凭证）' : '') + '，刷新页面生效');
  });

  function boot() {
    // ⓪ 「生成器」标签页排在最前面认领。它开出来的地址往往本身就是列表页或岗位详情页，
    //    晚一步就会被下面那几条当成「发作用的标签」「抓详情用的标签」抢走（然后自己关掉），
    //    这一轮就永远没人跑了 —— 和 v0.5.0 里发送标签必须排在详情标签前面是同一个道理。
    const ex = execRequest();
    if (ex) { runExecutor(ex); return; }
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
    if (isScriptListSendTab(req)) {
      runListSend(req);
      return;   // 发送用的列表页标签不建面板，免得用户以为要在这儿操作
    }
    if (req && req.via !== 'list' && req.url && sameJobPage(req.url, location.href)) {
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
    // 跨标签数据回收：轮询 GM 存储（JD 是后台标签写进去的，见 refreshDetails）
    setInterval(() => {
      if (refreshDetails()) renderJobs();
      const p = load(K.pending, []) || [];
      if (p.length !== pending.length) pending = p;
    }, 2000);

    if (getResume()) log('已加载简历缓存 ' + getResume().length + ' 字');
    // 这一页是新上下文（多半是整页跳转之后重新起来的）：先把上一页的日志接上，再盯着有没有
    // 没跑完的批量可以接手。用户报的现场就是这两样在旧版本里都会凭空消失。
    if (restoredLogs) log('· 上面 ' + restoredLogs + ' 行是上一页留下的日志（这一页是重新加载出来的）');
    log('面板已就绪（脚本 v' + VER + '）。快捷键 Alt+P 显示/隐藏');
    if (cfg.bgExecutor) log('· 「开始批量」会把这一轮交给后台的「生成器」标签页跑：你切到别的岗位页、翻页、关面板都不打断生成（不想多一个标签页就到「设置」里关掉）');
    watchResume();
  }

  // 只有「这一页自己就是执行者」时才拦你离开 —— 平时执行者是后台那个生成器标签页，
  // 这一页跳走什么也不会打断，弹一道「是否离开网站？」纯属添乱（v0.5.4 之前它每轮都要弹一次）。
  window.addEventListener('beforeunload', (e) => {
    if (!runner.running) return;
    saveLog(true);
    e.preventDefault();
    e.returnValue = '批量任务正在进行：离开这一页会把它打断（剩下的条数可以在「队列」页点「继续上次批量」接上）';
    return e.returnValue;
  });
  // 移动端/后台标签被系统回收时不一定走 beforeunload，pagehide 兜最后一份日志
  window.addEventListener('pagehide', () => { saveLog(true); });

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
