# Portfolio Tracker local server
# 开网页 + 帮网页抓 Bursa 数据（绕过浏览器 CORS 限制）
#   /api/quotes?symbols=1155.KL,5183.KL  -> Yahoo Finance 最新价/闭市价
#   /api/exdividends                     -> i3investor 未来30天 ex-dividend 列表
#   /api/ipos                            -> iSaham 即将上市 IPO（ACE / Main Market）
import html as html_mod
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
IPO_URL = "https://www.isaham.my/ipo"  # iSaham IPO 页（含 ACE / Main 即将上市的完整资料）
KLSE_IPO_URL = "https://www.klsescreener.com/v2/ipos"  # KLSE Screener：补 Bursa 数字代码（iSaham 没有）
KLSE_NEWS_URL = "https://www.klsescreener.com/v2/news/stock/"  # 个股完整新闻列表（找研究行目标价）
TARGET_KW = r"fair value|target price|\bTP\b|合理价|目标价|公平价值"  # 目标价关键词（中英）
RESEARCH_HOUSES = r"PublicInvest|Public Investment Bank|RHB|Kenanga|MIDF|Hong Leong|HLIB|Maybank|CGS|TA Securities|AmInvest(?:ment)?|Apex|BIMB|UOB|Mercury|Phillip|Inter-Pacific|Rakuten|大众投资银行|大众投行|马六甲证券|兴业投资银行|丰隆投资银行|肯纳格|马银行|联昌|艾芬|达证券|大马投资银行|大马投行|乐天|丰隆|兴业"
# 同一家研究行的中英文/全简称归一，避免重复（如 大众投资银行 = PublicInvest）
HOUSE_ALIASES = [
    ["PublicInvest", "Public Investment Bank", "大众投资银行", "大众投行"],
    ["RHB", "兴业投资银行", "兴业"], ["HLIB", "Hong Leong", "丰隆投资银行", "丰隆"],
    ["Kenanga", "肯纳格"], ["Maybank", "马银行"], ["CGS", "联昌"],
    ["TA", "TA Securities", "达证券"], ["AmInvest", "AmInvestment", "大马投资银行", "大马投行"],
    ["Rakuten", "乐天"], ["Malacca", "马六甲证券"], ["Affin", "艾芬"],
]


def canon_house(s):
    if not s:
        return ""
    low = s.lower()
    for g in HOUSE_ALIASES:
        if any(a.lower() == low for a in g):
            return g[0]
    return s


def parse_klse_codes(page):
    # 从 KLSE Screener IPO 页建「短名 -> 数字代码」对照表（如 SUM -> 0459）
    out = {}
    for code, short in re.findall(r'/v2/stocks/view/([0-9A-Z]+)">([^<]+)</a></h4>', page, re.I):
        out[short.strip().upper()] = code
    return out


def target_price_from(t):
    # 从一段文字里抽目标价：RM0.38 / 38 sen / 38仙 / 0.38令吉
    m = re.search(r"RM\s?(\d+\.\d{1,3})", t, re.I)
    if m:
        return "%.2f" % float(m.group(1))
    m = re.search(r"(\d+(?:\.\d+)?)\s*(?:仙|sen)(?![a-z])", t, re.I)
    if m:
        return "%.2f" % (float(m.group(1)) / 100)
    m = re.search(r"(\d+\.\d+)\s*令吉", t)
    if m:
        return "%.2f" % float(m.group(1))
    return ""


def extract_targets(page):
    # 从个股完整新闻列表里抽出「所有」研究行给的目标价（中英都认，best-effort）
    out, seen = [], set()
    for m in re.finditer(r'href="(/v2/news/view/[^"]+)"[^>]*>([^<]{4,200})</a>', page):
        chunk = squash(strip_tags(page[m.start():m.start() + 600]))  # 标题 + 摘要
        if not re.search(TARGET_KW, chunk, re.I):
            continue
        price = target_price_from(chunk)
        if not price:
            continue
        hm = re.search(RESEARCH_HOUSES, chunk, re.I)
        source = canon_house(hm.group(0) if hm else "")
        key = source or price  # 同一家研究行只取最新一篇
        if key in seen:
            continue
        seen.add(key)
        out.append({"price": price, "source": source,
                    "headline": squash(strip_tags(m.group(2))),
                    "url": "https://www.klsescreener.com" + m.group(1)})
        if len(out) >= 5:
            break
    return out


def strip_tags(s):
    return html_mod.unescape(re.sub(r"<[^>]+>", " ", s or "")).replace("\xa0", " ")


def squash(s):
    return re.sub(r"\s+", " ", s).strip()


def parse_ipos(page):
    # 去掉 script/style，避免里面的字干扰
    H = re.sub(r"<script[\s\S]*?</script>", " ", page, flags=re.I)
    H = re.sub(r"<style[\s\S]*?</style>", " ", H, flags=re.I)
    # 每家完整 IPO 卡的卡头是 <h5> 里的「CODE | Company Name Berhad」
    heads = []
    for m in re.finditer(r"<h5[^>]*>([\s\S]*?)</h5>", H, re.I):
        txt = squash(strip_tags(m.group(1)))
        mm = re.match(r"^([A-Z0-9&]+)\s*\|\s*(.+?(?:Berhad|Bhd))\b", txt)
        if mm:
            heads.append((m.start(), mm.group(1).strip(), mm.group(2).strip()))

    def field(t, pat):
        x = re.search(pat, t, re.I)
        return x.group(1).strip() if x else ""

    rows = []
    for i, (pos, code, name) in enumerate(heads):
        end = heads[i + 1][0] if i + 1 < len(heads) else pos + 9000
        t = squash(strip_tags(H[pos:end]))
        market = field(t, r"Market\s*:?\s*(ACE|Main|LEAP)").upper()
        if market not in ("ACE", "MAIN"):  # 只要 ACE / Main
            continue
        biz = field(t, r"Insights\s+([\s\S]+?)\s*Utilisation of Proceeds")
        if len(biz) > 240:
            biz = re.sub(r"\s+\S*$", "", biz[:240]) + "…"
        rows.append({
            "code": code,
            "name": name,
            "market": "Main" if market == "MAIN" else "ACE",
            "price": field(t, r"Listing Price\s*:?\s*(?:RM\s*)?([0-9.]+)"),
            "closeDate": field(t, r"Closing Date\s*:?\s*(\d{2}-[A-Za-z]{3}-\d{4})"),
            "listingDate": field(t, r"Listing Date\s*:?\s*(\d{2}-[A-Za-z]{3}-\d{4})"),
            "oversub": field(t, r"Oversubscription rate\s*:?\s*([0-9.]+\s*x)"),
            "adviser": field(t, r"Principal Adviser\s*:?\s*(.+?)\s+(?:Issuing House|Joint|Underwriter|Shariah|Sponsor|Bumiputera|Selling)"),
            "business": biz,
        })
    return rows


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
        elif self.path.startswith("/api/ipos"):
            self.handle_ipos()
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

    def handle_ipos(self):
        try:
            rows = parse_ipos(http_get(IPO_URL))
            try:
                codes = parse_klse_codes(http_get(KLSE_IPO_URL))  # 短名 -> Bursa 数字代码
            except Exception:
                codes = {}
            for r in rows:
                r["stockCode"] = codes.get(r["code"].upper(), "")
                if r["stockCode"]:  # 个股完整新闻列表抓研究行目标价（best-effort）
                    try:
                        t = extract_targets(http_get(KLSE_NEWS_URL + r["stockCode"]))
                        if t:
                            r["targets"] = t  # [{price, source, headline, url}, ...]
                    except Exception:
                        pass
            self.send_json({"source": IPO_URL, "rows": rows})
        except Exception as e:
            self.send_json({"error": str(e)}, status=502)

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
