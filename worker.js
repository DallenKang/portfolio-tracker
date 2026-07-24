// Portfolio Tracker — Cloudflare Worker（云端版 server.py）
// 部署到 Cloudflare Workers 后，给 GitHub Pages 上的网页抓数据：
//   GET /api/quotes?symbols=1155.KL,5183.KL  -> Yahoo Finance 最新价/闭市价
//   GET /api/exdividends                     -> i3investor 未来30天 ex-dividend
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const WORKER_VERSION = "v18-warrants"; // 每次改 worker 就改这个名字：部署后 /api/ipos 会返回它，一看就知道线上跑的是哪版
const EXDIV_URLS = [
  "https://klse.i3investor.com/web/entitlement/dividend/latestex", // Ex Date next 30 days
  "https://klse.i3investor.com/web/entitlement/dividend/latest",   // fallback
];
const IPO_URL = "https://www.isaham.my/ipo"; // iSaham IPO 页（含 ACE / Main 即将上市的完整资料）
const KLSE_IPO_URL = "https://www.klsescreener.com/v2/ipos"; // KLSE Screener：补 Bursa 数字代码（iSaham 没有）

const KLSE_NEWS_URL = "https://www.klsescreener.com/v2/news/stock/"; // 个股完整新闻列表（找研究行目标价）
const TARGET_KW = /fair value|target price|\bTP\b|合理价|目标价|公平价值/i; // 目标价关键词（中英）
const RESEARCH_HOUSES = /PublicInvest|Public Investment Bank|RHB|Kenanga|MIDF|Hong Leong|HLIB|Maybank|CGS|TA Securities|TA Research|AmInvest(?:ment)?|Apex|BIMB|UOB|Mercury|Phillip|Inter-Pacific|Malacca Securities|Malacca|Rakuten|Tradeview|大众投资银行|大众投行|马六甲证券|兴业投资银行|丰隆投资银行|肯纳格|马银行|联昌|艾芬|达证券|大马投资银行|大马投行|乐天|丰隆|兴业/i;
const MULTI_STOCK_TITLE = /trading idea|stocks? (to|on|in) watch|stocks? on radar|market roundup|交易灵感|交易点子|焦点股|每日焦点|热门股/i; // 一次讲多只股的文章，跳过以免张冠李戴
const RESEARCHY_TITLE = /poised|prospects?|outlook|upside|undervalu|initiat|coverage|fair value|target price|合理价|目标价|看好|前景|潜在涨/i; // 研报式标题也当候选（投行名字可能藏在文章后段）
// 同一家研究行的中英文/全简称归一，避免重复（如 大众投资银行 = PublicInvest）
const HOUSE_ALIASES = [
  ["PublicInvest", "Public Investment Bank", "大众投资银行", "大众投行"],
  ["RHB", "兴业投资银行", "兴业"], ["HLIB", "Hong Leong", "丰隆投资银行", "丰隆"],
  ["Kenanga", "肯纳格"], ["Maybank", "马银行"], ["CGS", "联昌"],
  ["TA", "TA Securities", "TA Research", "达证券"], ["AmInvest", "AmInvestment", "大马投资银行", "大马投行"],
  ["Rakuten", "乐天"], ["Malacca", "Malacca Securities", "马六甲证券"], ["Affin", "艾芬"], ["Tradeview"],
];
function canonHouse(s) {
  if (!s) return "";
  const low = s.toLowerCase();
  for (const g of HOUSE_ALIASES) if (g.some(a => a.toLowerCase() === low)) return g[0];
  return s;
}

// 个股的历史企业行动 —— 主源 Pick@Stock（持牌 Bursa 数据），i3investor 只当交叉核对。
// GET /api/corpactions?codes=0278,5102 -> { "0278": [{exDate, type, ratio, factor, autoApply, needCheck, source}] }
//
// 为什么换掉 i3investor 当主源（2026-07-24 实测，会算错客户股数的坑）：
//   i3 把「免费凭单 bonus issue of WARRANTS」也标成 BONUS_ISSUE，跟真红股一模一样，分不出来。
//   实例 EDELTEQ 0278 2026-03-10「1:2」——Bursa 公告原文是 292,894,596 free WARRANTS，
//   除权日股价只跌 10.5%（真的 1 送 2 红股要跌 33%）。照 i3 自动跑会平白多给客户 50% 股票。
//   同样中招的还有 MINOX 0288 2025-02-03、RAMSSOL 0236 2023-02-24、GCB 5102 2025-06-17 那笔 1:4。
//   Pick@Stock 明确分开写 "Bonus Issue" 和 "Bonus Issue (Warrants)"，所以拿它当主源。
//
// 比例读法（已用 Yahoo 股价交叉验证：AFFIN 1:18=19/18、VSTECS 2:1=3、GCB 4:3=7/3、PHARMA 1:5=0.2）：
//   Bonus Issue / Share Dividend   "X : Y" = 每持 Y 送 X   -> 倍数 (X+Y)/Y
//   Split / Consolidation          "X : Y" = Y 股变成 X 股 -> 倍数 X/Y
// 只有「白送、股数直接变」的才 autoApply；凭单/附加股(要出钱)/dividend in specie 一律不自动。
const PAS_ENT_URL = "https://www.pickastock.info/api/Entitlement/";
const I3_ENT_URL = "https://klse.i3investor.com/web/stock/entitlement/";
const PAS_SYMBOLS_URL = "https://www.pickastock.info/api/TimeNSales/MainAceSymbol";

// 两边写法不同（"2 : 1" / "2.0000 : 1.0000"），比对前先化成同一个样子
function normRatio(r) {
  const p = String(r || "").split(":").map(x => parseFloat(x));
  return (p.length === 2 && p[0] > 0 && p[1] > 0) ? `${p[0]}:${p[1]}` : "";
}
function ratioFactor(kind, ratio) { // kind: "bonus" | "split"
  const p = String(ratio || "").split(":").map(x => parseFloat(x));
  if (!(p.length === 2 && p[0] > 0 && p[1] > 0)) return null;
  return kind === "split" ? p[0] / p[1] : (p[0] + p[1]) / p[1];
}

// 免费凭单「X : Y」= 每持 Y 股送 X 张凭单 -> 每股几张（EDELTEQ 1:2 = 0.5，公告原文
// "1 Warrant for every 2 existing ordinary shares" 核对过）
function warrantPerShare(ratio) {
  const p = String(ratio || "").split(":").map(x => parseFloat(x));
  return (p.length === 2 && p[0] > 0 && p[1] > 0) ? p[0] / p[1] : null;
}
// 有 "warrant" 字眼 ≠ 白拿的凭单。必须看公告原文，三种都实测过：
//   白拿  Bonus Issue (Warrants) GCB 2025："ISSUANCE OF ... FREE WARRANTS ... FOR EVERY FOUR (4) EXISTING SHARES"
//   白拿  Others (Warrants)      GCB 2019："Issue of ... free warrants ... for every 3 existing ordinary shares"
//   要钱  Rights Issue (Shares & Warrants) YINSON 2022：附加股 RM1.41 一股，认购了才附送凭单
//         —— 公告里照样有 "FREE DETACHABLE WARRANTS" 字眼，只看字眼会误判，所以先挡 RIGHT
//   不算  Others (Shares & Warrants) AFFIN 2000："Existing warrantholders entitlement to the adjustment"
//         —— 那是给旧凭单持有人调行使价，不是发新凭单给股东
function isFreeWarrant(type, desc) {
  const t = String(type || "").toUpperCase();
  if (!t.includes("WARRANT")) return false;
  if (t.includes("RIGHT")) return false;                       // 要出钱认购才有 -> 不自动给
  const d = String(desc || "").trim();
  if (!d) return t.includes("BONUS");                          // 没有公告文字时只信 "Bonus Issue (Warrants)"
  if (/existing warrant\s?holders|adjustment to the/i.test(d)) return false; // 调整旧凭单，不是新发
  if (/rights issue|issue price|subscription price/i.test(d)) return false;  // 描述里透露要认购
  // 要同时是「发新凭单」和「每持 N 股送 M 张」。注意 MINOX/RAMSSOL 写 "BONUS ISSUE OF ... WARRANTS"
  // 没有 free 字眼（bonus 本身就是白送），所以不能只认 free。
  const isIssue = /bonus issue|free\s+(\w+\s+){0,2}warrants?|issuance of|issue of/i.test(d);
  const perShare = /warrants?\s+for every|for every\s+[\w()\s]{0,20}(existing\s+)?(ordinary\s+)?shares?/i.test(d);
  return isIssue && perShare;
}
// 现在还在市的全部 counter（2700+）。用途：判断凭单到期了没有。
// 不能用「KLSE Screener 抓不抓得到价格」来判断 —— 它连早就下市的凭单也照样回传旧价（GCB-WA 实测）。
let liveSymbolsCache = null;
async function liveSymbols() {
  if (liveSymbolsCache) return liveSymbolsCache;
  const r = await fetch(PAS_SYMBOLS_URL, { headers: { "User-Agent": UA, "Referer": "https://www.pickastock.info/" } });
  liveSymbolsCache = new Set(Object.keys(await r.json()));
  return liveSymbolsCache;
}
// 把 Pick@Stock 的 EntitlementType 归类。返回 null = 跟股数无关，直接跳过。
function classifyPas(type) {
  const t = String(type || "").toUpperCase();
  if (t.includes("WARRANT")) return { kind: null, auto: false };          // 免费凭单：另一种证券，股数不变
  if (t.includes("RIGHT")) return { kind: null, auto: false };            // 附加股：要出钱，用户自己决定
  if (t.includes("SPECIE")) return { kind: null, auto: false };           // dividend in specie：派别家公司的股
  if (t.includes("CONSOLIDAT") || t.includes("SPLIT") || t.includes("SUBDIVI")) return { kind: "split", auto: true };
  if (t.includes("BONUS") || t.includes("SHARE DIVIDEND")) return { kind: "bonus", auto: true };
  if (t.includes("DIVIDEND") || t.includes("DISTRIBUTION") || t.includes("CAPITAL REPAYMENT")) return null; // 现金，走另一个接口
  return { kind: null, auto: false }; // "Others" 等含糊类别 -> 交给 i3 判，判不出就人工看
}
async function pasEntitlements(code) {
  const r = await fetch(PAS_ENT_URL + encodeURIComponent(code) + "?page=1&rows=200",
    { headers: { "User-Agent": UA, "Referer": "https://www.pickastock.info/" } });
  const j = await r.json();
  return Array.isArray(j.items) ? j.items : [];
}
async function i3Entitlements(code) {
  const html = await (await fetch(I3_ENT_URL + encodeURIComponent(code), { headers: { "User-Agent": UA } })).text();
  const m = html.match(/var dtdata = (\[.*?\]);/s);
  if (!m) return [];
  return JSON.parse(m[1]).map(r => ({
    exDate: isoFromDMY(String(r[1] || "")), annDate: isoFromDMY(String(r[0] || "")),
    type: String(r[2] || "").toUpperCase(), subject: String(r[3] || ""), ratio: String(r[4] || "").trim(),
    detail: String(r[5] || ""), // 详情页链接，里面有 Bursa 公告原文
  })).filter(x => x.exDate && x.type !== "DIVIDEND");
}
// i3 只写 BONUS_ISSUE、看不出是股票还是凭单时，去详情页读 Bursa 公告原文来断。
// EDELTEQ 实例读到："Bonus issue of up to 292,894,596 free warrants ... 1 Warrant for every 2 existing ordinary shares"
async function i3IsWarrant(detailPath) {
  if (!detailPath) return null;
  try {
    const html = await (await fetch("https://klse.i3investor.com" + detailPath,
      { headers: { "User-Agent": UA, "Referer": "https://klse.i3investor.com/" } })).text();
    const txt = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    if (/renounceable|rights issue|issue price of rm/i.test(txt)) return null; // 要认购的，不是白拿
    if (/free warrants?|bonus issue of .{0,40}warrants?|warrants? for every/i.test(txt)) return true;
    if (/bonus issue of .{0,60}(ordinary )?shares?/i.test(txt)) return false;
  } catch (e) { /* 读不到就当不确定 */ }
  return null; // 断不出来 -> 交给用户人工看
}
async function corpActions(code) {
  // 两个源同时抓；Pick@Stock 是主，i3 用来 (a) 解释 "Others" (b) 补 Pick@Stock 漏掉的
  const [pas, i3] = await Promise.all([
    pasEntitlements(code).catch(() => null),
    i3Entitlements(code).catch(() => []),
  ]);
  if (pas === null) throw new Error("pickastock entitlement failed for " + code);
  // 同一天可能有好几笔（PHARMA 2013-05-31 同时有 BONUS_ISSUE 1:10 和 STOCK_SPLIT 2:1），
  // 只按日期找会拿错笔 -> 先用「日期+比例」精确配对，配不到才退回只看日期。
  const i3ByKey = new Map(), i3ByDate = new Map();
  for (const e of i3) {
    const k = e.exDate + "|" + normRatio(e.ratio);
    if (!i3ByKey.has(k)) i3ByKey.set(k, e);
    if (!i3ByDate.has(e.exDate)) i3ByDate.set(e.exDate, e);
  }

  const out = [], seen = new Set();
  for (const it of pas) {
    const exDate = isoFromDMonY(String(it.ExDate || ""));
    if (!exDate) continue;
    const cls = classifyPas(it.EntitlementType);
    if (cls === null) continue; // 现金股息
    const ratio = String(it.Ratio || "").trim();
    let { kind, auto } = cls;
    // Pick@Stock 用 "Others" 装拆股，含糊；问 i3 同一天是什么
    if (!kind && ratio) {
      const peer = i3ByKey.get(exDate + "|" + normRatio(ratio)) || i3ByDate.get(exDate);
      const pt = peer ? peer.type : "";
      if (pt.includes("SPLIT") || pt.includes("CONSOLIDAT")) { kind = "split"; auto = true; }
    }
    const factor = kind ? ratioFactor(kind, ratio) : null;
    const isW = isFreeWarrant(it.EntitlementType, it.EntitlementDesc);
    seen.add(exDate);
    out.push({
      exDate, annDate: isoFromDMonY(String(it.AnnDate || "")),
      type: String(it.EntitlementType || ""), subject: String(it.EntitlementDesc || it.EntitlementType || ""),
      ratio, factor, source: "pickastock", ref: it.ReferenceUrl || "",
      autoApply: !!(auto && factor && factor !== 1),
      needCheck: false,
      isWarrant: isW, perShare: isW ? warrantPerShare(ratio) : null,
    });
  }
  // i3 有、Pick@Stock 没有的（例：EDELTEQ 的凭单）：去详情页读公告原文断是股票还是凭单；断不出才丢给用户
  for (const e of i3) {
    if (seen.has(e.exDate)) continue;
    const w = e.type.includes("BONUS") || e.type.includes("WARRANT") ? await i3IsWarrant(e.detail) : null;
    out.push({
      exDate: e.exDate, annDate: e.annDate, type: e.type, subject: e.subject, ratio: e.ratio,
      factor: w === false ? ratioFactor("bonus", e.ratio) : null,
      source: w === null ? "i3investor" : "i3investor+announcement", ref: "",
      autoApply: false,   // 单一来源，股数一律不自动改
      needCheck: w === null, // 公告读得出来就不用再问用户
      isWarrant: w === true, perShare: w === true ? warrantPerShare(e.ratio) : null,
    });
  }
  out.sort((a, b) => a.exDate.localeCompare(b.exDate));

  // 凭单代号：Bursa 惯例是母股代码 + WA / WB / WC…，按送出的先后顺序排。
  // 到期的凭单不能算进持仓 -> 用 Pick@Stock 的在市 symbol 表确认（不能用「有没有价格」判断，
  // KLSE Screener 连早就下市的凭单也照回旧价，GCB-WA 实测）。
  const base = (pas[0] && pas[0].Symbol) ? String(pas[0].Symbol).toUpperCase() : "";
  const wEvents = out.filter(x => x.isWarrant && x.perShare > 0);
  if (base && wEvents.length) {
    const live = await liveSymbols().catch(() => null);
    wEvents.forEach((e, i) => {
      const letter = String.fromCharCode(65 + i); // 第1次送 -> WA，第2次 -> WB…
      e.warrantSymbol = `${base}-W${letter}`;
      e.warrantCode = `${code}W${letter}`;
      e.warrantLive = live ? live.has(e.warrantSymbol) : null; // null = 查不到在市名单，前端不要自动加
    });
  }
  return out;
}
function isoFromDMY(s) { // "10-Mar-2026" -> "2026-03-10"
  const p = s.split("-");
  return (p.length === 3 && MON3[p[1]]) ? `${p[2]}-${MON3[p[1]]}-${p[0].padStart(2, "0")}` : "";
}
function isoFromDMonY(s) { // "10 Mar 2026" -> "2026-03-10"
  const p = String(s).trim().split(/\s+/);
  return (p.length === 3 && MON3[p[1]]) ? `${p[2]}-${MON3[p[1]]}-${p[0].padStart(2, "0")}` : "";
}

// 红股 / 拆股 / 送股 预告（i3investor「Bonus, Share Split & Consolidation」）
// GET /api/entitlements -> [{exDate, annDate, stock, code, type, ratio, factor, price}]
// 比例意思（已用 Yahoo 交叉验证）：
//   Bonus Issue / Share Dividend  "X : Y" = 每持 Y 送 X  -> 倍数 (X+Y)/Y
//   Share Consolidation           "X : Y" = Y 股并成 X 股 -> 倍数 X/Y
const ENT_URL = "https://klse.i3investor.com/web/entitlement/other/latest";
async function entitlements() {
  const html = await (await fetch(ENT_URL, { headers: { "User-Agent": UA } })).text();
  const m = html.match(/var dtdata = (\[.*?\]);/s);
  if (!m) throw new Error("dtdata not found");
  const out = [];
  for (const r of JSON.parse(m[1])) {
    const type = String(r[2] || "");
    if (type === "Adjustment" || type === "Profit Payment") continue; // 窝轮调整/派息，不是股数变动
    const ratio = String(r[5] || "").trim();
    const p = ratio.split(":").map(x => parseFloat(x));
    let factor = null;
    if (p.length === 2 && p[0] > 0 && p[1] > 0) {
      factor = /consolidation|consolidat/i.test(type) ? p[0] / p[1] : (p[0] + p[1]) / p[1];
    }
    out.push({
      exDate: String(r[6] || ""), annDate: String(r[0] || ""),
      stock: String(r[1] || ""), code: String(r[7] || "").replace(/\/+$/, "").split("/").pop(),
      type, ratio, factor, price: String(r[4] || ""),
    });
  }
  return out;
}

// 历史股息（近5年）：给「顾客持有期间的股息」自动补记用
// GET /api/divhistory?symbols=7293.KL,5185.KL -> { "7293.KL": [{exDate:"2025-12-03", dps:0.01}, ...] }
async function divHistory(symbol) {
  const p2 = Math.floor(Date.now() / 1000);
  const p1 = p2 - 5 * 365 * 24 * 3600; // 近5年
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d&events=div`,
    { headers: { "User-Agent": UA } });
  const res = (await r.json()).chart.result[0];
  const evs = (res && res.events && res.events.dividends) || {};
  return Object.values(evs).map(e => ({
    exDate: new Date(e.date * 1000).toISOString().slice(0, 10),
    dps: e.amount,
  })).filter(d => d.dps > 0).sort((a, b) => a.exDate.localeCompare(b.exDate));
}

// 红股/拆股（近5年）：给「持仓自动调整股数」用
// GET /api/splits?symbols=5185.KL -> { "5185.KL": [{exDate:"2025-04-30", factor:1.0556, ratio:"19:18"}] }
async function splitHistory(symbol) {
  const p2 = Math.floor(Date.now() / 1000);
  const p1 = p2 - 5 * 365 * 24 * 3600;
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${p1}&period2=${p2}&interval=1d&events=split`,
    { headers: { "User-Agent": UA } });
  const res = (await r.json()).chart.result[0];
  const evs = (res && res.events && res.events.splits) || {};
  return Object.values(evs).map(e => ({
    exDate: new Date(e.date * 1000).toISOString().slice(0, 10),
    factor: e.numerator / e.denominator, // 持股要乘的倍数（如 1送18 -> 19/18）
    ratio: e.splitRatio || `${e.numerator}:${e.denominator}`,
  })).filter(s => s.factor > 0 && s.factor !== 1).sort((a, b) => a.exDate.localeCompare(b.exDate));
}

// Yahoo 抓不到时的后备：从 KLSE Screener 个股页抓现价（用数字代码）
async function klseQuote(code) {
  const html = await (await fetch("https://www.klsescreener.com/v2/stocks/view/" + encodeURIComponent(code),
    { headers: { "User-Agent": UA } })).text();
  const m = html.match(/id="price-fixed"[^>]*data-value="([\d.]+)"/i);
  if (!m) return null;
  const nm = html.match(/<title>\s*([^:<]+?)\s*:/i);
  return { price: parseFloat(m[1]), name: nm ? nm[1].trim() : undefined, source: "klse" };
}

// 从 KLSE Screener IPO 页建「短名 -> 数字代码」对照表（如 SUM -> 0459）
function parseKlseCodes(html) {
  const map = {};
  const re = /\/v2\/stocks\/view\/([0-9A-Z]+)">([^<]+)<\/a><\/h4>/gi;
  let m;
  while ((m = re.exec(html)) !== null) map[m[2].trim().toUpperCase()] = m[1];
  return map;
}

// 从「单篇文章正文」里抽目标价：要求「目标价/合理价/fair value」紧贴数字，
// 避免误抓发售价/盈利等无关数字（给顾客看的，宁可漏掉也不能错）
function targetFromBody(t) {
  const pats = [
    /(?:目标价|合理价|公平价值)[^0-9]{0,10}(\d+(?:\.\d+)?)\s*(仙|sen|令吉)?/i,
    /(?:fair value|target price)[^0-9]{0,10}(?:RM\s*)?(\d+(?:\.\d+)?)\s*(仙|sen|令吉)?/i,
    /(\d+(?:\.\d+)?)\s*(仙|sen)\s*(?:的)?(?:目标价|合理价|fair value|target price)/i,
  ];
  for (const p of pats) {
    const m = t.match(p);
    if (m) {
      const v = +m[1], u = (m[2] || "").toLowerCase();
      return (u === "仙" || u === "sen" || (u === "" && v >= 5)) ? (v / 100).toFixed(2) : v.toFixed(2);
    }
  }
  // 「同等/相同目标价」= 跟 IPO 发售价一样
  if (/(?:同等|相同)\s*目标价|目标价[^0-9]{0,8}(?:同等|相同)|equal[^.]{0,15}(?:target|fair value)/i.test(t)) {
    const m = t.match(/(\d+(?:\.\d+)?)\s*仙\s*(?:的)?(?:发售价|新股|IPO)/) || t.match(/(?:发售价|IPO price)[^0-9]{0,8}(?:RM)?\s*(\d+(?:\.\d+)?)/i);
    if (m) { const v = +m[1]; return (v >= 5 ? v / 100 : v).toFixed(2); }
  }
  return "";
}
// 从新闻标题抓超额认购倍数（iSaham 字段更新慢/不更新，新闻先有）
// 同一只股不同标题可能写 7.77 或圆整的 7.8 —— 取「小数位最多」那个（最精确）
function oversubFromNews(list) {
  const titles = stripTags((list.match(/<h2 class="figcaption"><a[^>]*>([^<]+)<\/a>/gi) || []).join(" || "));
  const nums = [];
  let m;
  const re1 = /(?:oversubscribed\s*(?:by\s*)?|超额认购\s*(?:近|逾|约)?\s*)(\d+(?:\.\d+)?)\s*(?:times|倍)/gi;
  while ((m = re1.exec(titles)) !== null) nums.push(m[1]);
  const re2 = /(\d+(?:\.\d+)?)\s*(?:times|倍)\s*(?:的)?(?:oversubscrib\w*|超额认购|超购)/gi;
  while ((m = re2.exec(titles)) !== null) nums.push(m[1]);
  if (!nums.length) return "";
  nums.sort((a, b) => ((b.split(".")[1] || "").length) - ((a.split(".")[1] || "").length));
  return nums[0] + "x";
}
// 超额认购统一成两位小数：7.8x -> 7.80x，26.92x -> 26.92x，空的保持空
function fmtOversub(s) {
  const m = (s || "").match(/(\d+(?:\.\d+)?)/);
  return m ? (+m[1]).toFixed(2) + "x" : "";
}
// 抓某只股的新闻：所有研究行目标价（点进正文）+ 超额认购倍数（从标题）。best-effort
async function collectNews(stockCode) {
  // 抓 2 页新闻：IPO 上市当天大量新闻会把几天前的研报挤到第 2 页
  const ua = { headers: { "User-Agent": UA } };
  const list = (await fetch(KLSE_NEWS_URL + stockCode, ua).then(r => r.text()))
    + (await fetch(KLSE_NEWS_URL + stockCode + "/2", ua).then(r => r.text()).catch(() => ""));
  const out = [], seen = new Set();
  let fetched = 0, origFetched = 0, m;
  const re = /<h2 class="figcaption"><a[^>]*href="(\/v2\/news\/view\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
  while ((m = re.exec(list)) !== null) {
    if (fetched >= 6) break;
    const title = stripTags(m[2]);
    if (MULTI_STOCK_TITLE.test(title)) continue; // 跳过一次讲多只股的文章
    const chunk = stripTags(list.slice(m.index, m.index + 500)); // 标题 + 摘要，判断要不要点进去
    if (!RESEARCH_HOUSES.test(chunk) && !TARGET_KW.test(chunk) && !RESEARCHY_TITLE.test(title)) continue;
    fetched++;
    let rawArt;
    try { rawArt = await fetch("https://www.klsescreener.com" + m[1], { headers: { "User-Agent": UA } }).then(r => r.text()); }
    catch (e) { continue; }
    let body = stripTags(rawArt);
    let price = targetFromBody(body);
    // KLSE Screener 有些文章只是节选（TheStar snapshot），数字被截掉——跟去原文抓（每股最多2次）
    if (!price && origFetched < 2 && RESEARCH_HOUSES.test(body)) {
      const om = rawArt.match(/href="(https?:\/\/www\.thestar\.com\.my[^"]+)"/i);
      if (om) {
        origFetched++;
        const origUrl = om[1].replace(/^http:/, "https:");
        // TheStar 挡 Cloudflare 机房：先直连，不行就走 r.jina.ai 文字镜像（实测能读到全文）
        for (const u of [origUrl, "https://r.jina.ai/" + origUrl]) {
          try {
            const ot = stripTags(await fetch(u, { headers: { "User-Agent": UA } }).then(r => r.text()));
            const p2 = targetFromBody(ot);
            if (p2) { price = p2; body = ot; break; } // 投行名字也从原文认
          } catch (e) {}
        }
      }
    }
    if (!price) continue;
    const hm = body.match(RESEARCH_HOUSES);
    const source = canonHouse(hm ? hm[0] : "");
    const key = source || price;           // 同一家研究行只取最新一篇
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ price, source, headline: stripTags(m[2]), url: "https://www.klsescreener.com" + m[1] });
  }
  return { targets: out, oversub: oversubFromNews(list) };
}

// 把 HTML 实体还原成普通文字（M &amp; A -> M & A，O&#039;G -> O'G）
function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}
const stripTags = s => decodeEntities((s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// 从 iSaham IPO 页解析出 ACE / Main 即将上市公司
const MON3 = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };

// 从 KLSE Screener /v2/ipos 解析即将上市的 ACE / Main 公司
// （iSaham 2026-07 起被 Cloudflare 锁死，改用这里；underwriter 字段这里没有）
// 只数「解析得出来的 IPO 卡」有几张（不管上市日期和板块）。
// 用来判断数据源健不健康：>0 = 页面结构没变；0 = 被封或改版了。
function parseIpoCards(html) {
  const found = [];
  for (const c of html.split('<div class="card mb-3').slice(1)) {
    const yr = c.match(/title="(20\d\d)"/);
    const mo = c.match(/text-uppercase">([A-Z][a-z]{2})/);
    const dy = c.match(/<h3>(\d{1,2})<\/h3>/);
    const cm = c.match(/\/v2\/stocks\/view\/([0-9A-Z]+)">([^<]+)<\/a><\/h4>/);
    const board = c.match(/Board:\s*<\/span>\s*<strong>([^<]+)/);
    if (yr && mo && dy && cm && board) found.push(cm[2].trim());
  }
  return found;
}

function parseIpos(html) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  for (const c of html.split('<div class="card mb-3').slice(1)) {
    const yr = c.match(/title="(20\d\d)"/);
    const mo = c.match(/text-uppercase">([A-Z][a-z]{2})/);
    const dy = c.match(/<h3>(\d{1,2})<\/h3>/);
    const cm = c.match(/\/v2\/stocks\/view\/([0-9A-Z]+)">([^<]+)<\/a><\/h4><span[^>]*>([^<]+)<\/span>/);
    const board = c.match(/Board:\s*<\/span>\s*<strong>([^<]+)/);
    if (!(yr && mo && dy && cm && board)) continue;
    const iso = `${yr[1]}-${MON3[mo[1]] || "00"}-${dy[1].padStart(2, "0")}`;
    const bd = board[1].trim();
    if (iso < today || (!bd.includes("ACE") && !bd.includes("Main"))) continue; // 只要未上市的 ACE / Main
    const close = c.match(/Close:<\/span>\s*([0-9]{1,2}\s[A-Za-z]{3})/);
    const sec = c.match(/Sector:\s*<\/span>\s*<strong>([^<]+)/);
    const sub = c.match(/Sub sector:\s*<\/span>\s*<strong>([^<]+)/);
    const price = c.slice(cm.index + cm[0].length).match(/>\s*([0-9]+\.[0-9]{1,3})\s*</);
    let biz = sec ? stripTags(sec[1]) : "";
    if (sub) biz += " · " + stripTags(sub[1]);
    rows.push({
      stockCode: cm[1],
      code: cm[2].trim(),
      name: stripTags(cm[3]),
      market: bd.includes("Main") ? "Main" : "ACE",
      price: price ? (+price[1]).toFixed(2) : "",
      listingDate: `${dy[1].padStart(2, "0")}-${mo[1]}-${yr[1]}`,
      closeDate: close ? close[1].replace(" ", "-") + "-" + yr[1] : "",
      oversub: "",
      business: biz,
    });
  }
  return rows;
}

export { parseIpos }; // 便于本地测试

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: cors });

    try {
      if (url.pathname === "/api/quotes") {
        const symbols = (url.searchParams.get("symbols") || "").split(",").slice(0, 60);
        const out = {};
        await Promise.all(symbols.map(async raw => {
          const s = raw.trim().toUpperCase();
          if (!s) return;
          // 1) 先试 Yahoo
          try {
            const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(s),
              { headers: { "User-Agent": UA } });
            const meta = (await r.json()).chart.result[0].meta;
            if (meta && meta.regularMarketPrice > 0) {
              out[s] = {
                price: meta.regularMarketPrice,
                prevClose: meta.chartPreviousClose,
                name: meta.longName || meta.shortName,
                time: meta.regularMarketTime,
                source: "yahoo",
              };
              return;
            }
          } catch (e) {}
          // 2) Yahoo 没有 -> 自动转 KLSE Screener（窝轮/新股等）
          try {
            const q = await klseQuote(s.replace(/\.KL$/i, ""));
            if (q && q.price > 0) { out[s] = q; return; }
          } catch (e) {}
          out[s] = { error: "no price from Yahoo or KLSE" };
        }));
        return json(out);
      }

      if (url.pathname === "/api/corpactions") {
        const codes = (url.searchParams.get("codes") || "").split(",").slice(0, 60);
        const out = {};
        await Promise.all(codes.map(async raw => {
          const c = raw.trim().toUpperCase();
          if (!c) return;
          try { out[c] = await corpActions(c); } catch (e) { out[c] = { error: String(e) }; }
        }));
        return json({ version: WORKER_VERSION, data: out });
      }

      if (url.pathname === "/api/entitlements") {
        return json({ source: ENT_URL, version: WORKER_VERSION, rows: await entitlements() });
      }

      if (url.pathname === "/api/splits") {
        const symbols = (url.searchParams.get("symbols") || "").split(",").slice(0, 60);
        const out = {};
        await Promise.all(symbols.map(async raw => {
          const s = raw.trim().toUpperCase();
          if (!s) return;
          try { out[s] = await splitHistory(s); } catch (e) { out[s] = { error: String(e) }; }
        }));
        return json(out);
      }

      if (url.pathname === "/api/divhistory") {
        const symbols = (url.searchParams.get("symbols") || "").split(",").slice(0, 60);
        const out = {};
        await Promise.all(symbols.map(async raw => {
          const s = raw.trim().toUpperCase();
          if (!s) return;
          try { out[s] = await divHistory(s); } catch (e) { out[s] = { error: String(e) }; }
        }));
        return json(out);
      }

      if (url.pathname === "/api/exdividends") {
        let lastErr = "";
        for (const src of EXDIV_URLS) {
          try {
            const html = await (await fetch(src, { headers: { "User-Agent": UA } })).text();
            const m = html.match(/var dtdata = (\[.*?\]);/s);
            if (!m) { lastErr = "dtdata not found in page"; continue; }
            // latestex 页: [exDate, stock, open, current, dividend, annDate, ...]
            // latest 页:   [annDate, stock, open, current, dividend, exDate, ...]
            const exFirst = src.includes("latestex");
            const rows = JSON.parse(m[1]).map(r => ({
              exDate: exFirst ? r[0] : r[5],
              annDate: exFirst ? r[5] : r[0],
              stock: r[1],
              price: r[3],
              dividend: r[4],
              code: (r[6] || "").replace(/\/+$/, "").split("/").pop(),
            }));
            return json({ source: src, rows });
          } catch (e) { lastErr = String(e); }
        }
        return json({ error: lastErr || "all sources failed" }, 502);
      }

      if (url.pathname === "/api/ipos") {
        try {
          const page = await fetch(KLSE_IPO_URL, { headers: { "User-Agent": UA } }).then(r => r.text());
          // 分辨两件事（不能混）：
          //   a) 页面拿不到 / 结构变了 -> 真的坏了，报错
          //   b) 页面正常、卡片解析得到，只是没有「未上市的 ACE/Main」-> 正常的 0 家
          const cards = parseIpoCards(page);           // 页面上所有 IPO 卡（不分日期/板块）
          if (!cards.length) return json({ error: "IPO source unavailable (blocked or structure changed)" }, 502);
          const rows = parseIpos(page);
          // 每家抓研究行目标价 + 超额认购（并行，best-effort）
          await Promise.all(rows.map(async r => {
            try {
              const n = await collectNews(r.stockCode);
              if (n.targets.length) r.targets = n.targets;     // [{price, source, headline, url}, ...]
              if (!r.oversub && n.oversub) r.oversub = n.oversub;
            } catch (e) { /* 没有就留空 */ }
          }));
          for (const r of rows) if (r.oversub) r.oversub = fmtOversub(r.oversub); // 统一两位小数
          // sourceOk = 页面确实读到了 IPO 卡；前端靠它分辨「真的没有」vs「抓不到」
          return json({ source: KLSE_IPO_URL, version: WORKER_VERSION, sourceOk: true, cardsSeen: cards.length, rows });
        } catch (e) {
          return json({ error: String(e) }, 502);
        }
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};
