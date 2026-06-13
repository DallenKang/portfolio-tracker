// Portfolio Tracker — Cloudflare Worker（云端版 server.py）
// 部署到 Cloudflare Workers 后，给 GitHub Pages 上的网页抓数据：
//   GET /api/quotes?symbols=1155.KL,5183.KL  -> Yahoo Finance 最新价/闭市价
//   GET /api/exdividends                     -> i3investor 未来30天 ex-dividend
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const EXDIV_URLS = [
  "https://klse.i3investor.com/web/entitlement/dividend/latestex", // Ex Date next 30 days
  "https://klse.i3investor.com/web/entitlement/dividend/latest",   // fallback
];

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

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};
