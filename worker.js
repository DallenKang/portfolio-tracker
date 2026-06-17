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

// 从 KLSE Screener IPO 页建「短名 -> 数字代码」对照表（如 SUM -> 0459）
function parseKlseCodes(html) {
  const map = {};
  const re = /\/v2\/stocks\/view\/([0-9A-Z]+)">([^<]+)<\/a><\/h4>/gi;
  let m;
  while ((m = re.exec(html)) !== null) map[m[2].trim().toUpperCase()] = m[1];
  return map;
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
          try {
            const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(s),
              { headers: { "User-Agent": UA } });
            const meta = (await r.json()).chart.result[0].meta;
            out[s] = {
              price: meta.regularMarketPrice,
              prevClose: meta.chartPreviousClose,
              name: meta.longName || meta.shortName,
              time: meta.regularMarketTime,
            };
          } catch (e) { out[s] = { error: String(e) }; }
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
