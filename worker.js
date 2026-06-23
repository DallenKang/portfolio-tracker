// Portfolio Tracker — Cloudflare Worker（云端版 server.py）
// 部署到 Cloudflare Workers 后，给 GitHub Pages 上的网页抓数据：
//   GET /api/quotes?symbols=1155.KL,5183.KL  -> Yahoo Finance 最新价/闭市价
//   GET /api/exdividends                     -> i3investor 未来30天 ex-dividend
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const EXDIV_URLS = [
  "https://klse.i3investor.com/web/entitlement/dividend/latestex", // Ex Date next 30 days
  "https://klse.i3investor.com/web/entitlement/dividend/latest",   // fallback
];
const IPO_URL = "https://www.isaham.my/ipo"; // iSaham IPO 页（含 ACE / Main 即将上市的完整资料）
const KLSE_IPO_URL = "https://www.klsescreener.com/v2/ipos"; // KLSE Screener：补 Bursa 数字代码（iSaham 没有）

const KLSE_NEWS_URL = "https://www.klsescreener.com/v2/news/stock/"; // 个股完整新闻列表（找研究行目标价）
const TARGET_KW = /fair value|target price|\bTP\b|合理价|目标价|公平价值/i; // 目标价关键词（中英）
const RESEARCH_HOUSES = /PublicInvest|Public Investment Bank|RHB|Kenanga|MIDF|Hong Leong|HLIB|Maybank|CGS|TA Securities|TA Research|AmInvest(?:ment)?|Apex|BIMB|UOB|Mercury|Phillip|Inter-Pacific|Rakuten|Tradeview|大众投资银行|大众投行|马六甲证券|兴业投资银行|丰隆投资银行|肯纳格|马银行|联昌|艾芬|达证券|大马投资银行|大马投行|乐天|丰隆|兴业/i;
// 同一家研究行的中英文/全简称归一，避免重复（如 大众投资银行 = PublicInvest）
const HOUSE_ALIASES = [
  ["PublicInvest", "Public Investment Bank", "大众投资银行", "大众投行"],
  ["RHB", "兴业投资银行", "兴业"], ["HLIB", "Hong Leong", "丰隆投资银行", "丰隆"],
  ["Kenanga", "肯纳格"], ["Maybank", "马银行"], ["CGS", "联昌"],
  ["TA", "TA Securities", "TA Research", "达证券"], ["AmInvest", "AmInvestment", "大马投资银行", "大马投行"],
  ["Rakuten", "乐天"], ["Malacca", "马六甲证券"], ["Affin", "艾芬"], ["Tradeview"],
];
function canonHouse(s) {
  if (!s) return "";
  const low = s.toLowerCase();
  for (const g of HOUSE_ALIASES) if (g.some(a => a.toLowerCase() === low)) return g[0];
  return s;
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
// 从新闻标题抓超额认购倍数（iSaham 字段更新慢/不更新，新闻先有），优先精确小数
function oversubFromNews(list) {
  const titles = stripTags((list.match(/<h2 class="figcaption"><a[^>]*>([^<]+)<\/a>/gi) || []).join(" || "));
  for (const p of [/oversubscribed\s*(?:by\s*)?(\d+\.\d+)\s*times/i, /超额认购\s*(\d+\.\d+)\s*倍/,
                   /oversubscribed\s*(?:by\s*)?(\d+)\s*times/i, /超额认购\s*(?:近|逾|约)?\s*(\d+)\s*倍/]) {
    const m = titles.match(p);
    if (m) return m[1] + "x";
  }
  return "";
}
// 抓某只股的新闻：所有研究行目标价（点进正文）+ 超额认购倍数（从标题）。best-effort
async function collectNews(stockCode) {
  // 抓 2 页新闻：IPO 上市当天大量新闻会把几天前的研报挤到第 2 页
  const ua = { headers: { "User-Agent": UA } };
  const list = (await fetch(KLSE_NEWS_URL + stockCode, ua).then(r => r.text()))
    + (await fetch(KLSE_NEWS_URL + stockCode + "/2", ua).then(r => r.text()).catch(() => ""));
  const out = [], seen = new Set();
  let fetched = 0, m;
  const re = /<h2 class="figcaption"><a[^>]*href="(\/v2\/news\/view\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
  while ((m = re.exec(list)) !== null) {
    if (fetched >= 6) break;
    const chunk = stripTags(list.slice(m.index, m.index + 500)); // 标题 + 摘要，判断要不要点进去
    if (!RESEARCH_HOUSES.test(chunk) && !TARGET_KW.test(chunk)) continue;
    fetched++;
    let body;
    try { body = stripTags(await fetch("https://www.klsescreener.com" + m[1], { headers: { "User-Agent": UA } }).then(r => r.text())); }
    catch (e) { continue; }
    const price = targetFromBody(body);
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
function parseIpos(html) {
  // 去掉 script/style，避免里面的字干扰
  const H = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  // 每家完整 IPO 卡的卡头是 <h5> 里的「CODE | Company Name Berhad」
  const heads = [];
  const re = /<h5[^>]*>([\s\S]*?)<\/h5>/gi;
  let m;
  while ((m = re.exec(H)) !== null) {
    const txt = stripTags(m[1]);
    const mm = txt.match(/^([A-Z0-9&]+)\s*\|\s*(.+?(?:Berhad|Bhd))\b/);
    if (mm) heads.push({ pos: m.index, code: mm[1].trim(), name: mm[2].trim() });
  }
  const field = (t, p) => { const x = t.match(p); return x ? x[1].trim() : ""; };
  const rows = [];
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].pos : heads[i].pos + 9000;
    const t = stripTags(H.slice(heads[i].pos, end));
    const market = field(t, /Market\s*:?\s*(ACE|Main|LEAP)/i).toUpperCase();
    if (market !== "ACE" && market !== "MAIN") continue; // 只要 ACE / Main
    let biz = field(t, /Insights\s+([\s\S]+?)\s*Utilisation of Proceeds/i);
    if (biz.length > 240) biz = biz.slice(0, 240).replace(/\s+\S*$/, "") + "…";
    rows.push({
      code: heads[i].code,
      name: heads[i].name,
      market: market === "MAIN" ? "Main" : "ACE",
      price: field(t, /Listing Price\s*:?\s*(?:RM\s*)?([0-9.]+)/i),
      closeDate: field(t, /Closing Date\s*:?\s*(\d{2}-[A-Za-z]{3}-\d{4})/i),
      listingDate: field(t, /Listing Date\s*:?\s*(\d{2}-[A-Za-z]{3}-\d{4})/i),
      oversub: field(t, /Oversubscription rate\s*:?\s*([0-9.]+\s*x)/i),
      adviser: field(t, /Principal Adviser\s*:?\s*(.+?)\s+(?:Issuing House|Joint|Underwriter|Shariah|Sponsor|Bumiputera|Selling)/i),
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
          const [ipoHtml, klseHtml] = await Promise.all([
            fetch(IPO_URL, { headers: { "User-Agent": UA } }).then(r => r.text()),
            fetch(KLSE_IPO_URL, { headers: { "User-Agent": UA } }).then(r => r.text()).catch(() => ""),
          ]);
          const rows = parseIpos(ipoHtml);
          const codes = parseKlseCodes(klseHtml); // 短名 -> Bursa 数字代码
          for (const r of rows) r.stockCode = codes[r.code.toUpperCase()] || "";
          // 每家抓研究行目标价（并行，best-effort）
          await Promise.all(rows.map(async r => {
            if (!r.stockCode) return;
            try {
              const n = await collectNews(r.stockCode);
              if (n.targets.length) r.targets = n.targets;     // [{price, source, headline, url}, ...]
              if (!r.oversub && n.oversub) r.oversub = n.oversub; // iSaham 字段空时用新闻的真实倍数
            } catch (e) { /* 没有就留空 */ }
          }));
          return json({ source: IPO_URL, rows });
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
