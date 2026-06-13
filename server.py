# Portfolio Tracker local server
# 开网页 + 帮网页抓 Bursa 数据（绕过浏览器 CORS 限制）
#   /api/quotes?symbols=1155.KL,5183.KL  -> Yahoo Finance 最新价/闭市价
#   /api/exdividends                     -> i3investor 未来30天 ex-dividend 列表
import json
import os
import re
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8745
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
EXDIV_URLS = [
    "https://klse.i3investor.com/web/entitlement/dividend/latestex",  # Ex Date next 30 days
    "https://klse.i3investor.com/web/entitlement/dividend/latest",    # fallback: announced past 3 months
]


def http_get(url, timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/quotes"):
            self.handle_quotes()
        elif self.path.startswith("/api/exdividends"):
            self.handle_exdividends()
        else:
            super().do_GET()

    def handle_quotes(self):
        qs = urllib.parse.urlparse(self.path).query
        symbols = urllib.parse.parse_qs(qs).get("symbols", [""])[0].split(",")
        out = {}
        for s in symbols[:60]:
            s = s.strip().upper()
            if not s:
                continue
            try:
                url = "https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(s)
                meta = json.loads(http_get(url, timeout=20))["chart"]["result"][0]["meta"]
                out[s] = {
                    "price": meta.get("regularMarketPrice"),
                    "prevClose": meta.get("chartPreviousClose"),
                    "name": meta.get("longName") or meta.get("shortName"),
                    "time": meta.get("regularMarketTime"),
                }
            except Exception as e:
                out[s] = {"error": str(e)}
        self.send_json(out)

    def handle_exdividends(self):
        last_err = None
        for url in EXDIV_URLS:
            try:
                html = http_get(url)
                m = re.search(r"var dtdata = (\[.*?\]);", html, re.S)
                if not m:
                    last_err = "dtdata not found in page"
                    continue
                # latestex 页: [exDate, stock, open, current, dividend, annDate, stockLink, ?, detailLink]
                # latest 页:   [annDate, stock, open, current, dividend, exDate, stockLink, ?, detailLink]
                ex_first = "latestex" in url
                rows = []
                for r in json.loads(m.group(1)):
                    rows.append({
                        "exDate": r[0] if ex_first else r[5],
                        "annDate": r[5] if ex_first else r[0],
                        "stock": r[1],
                        "price": r[3],
                        "dividend": r[4],
                        "code": (r[6] or "").rstrip("/").split("/")[-1],
                    })
                self.send_json({"source": url, "rows": rows})
                return
            except Exception as e:
                last_err = str(e)
        self.send_json({"error": last_err or "all sources failed"}, status=502)

    def send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f"Portfolio Tracker server running: http://localhost:{PORT}/portfolio-tracker.html")
    print("Keep this window open. Closing it stops auto price fetching.")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
