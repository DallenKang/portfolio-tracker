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
RESEARCH_HOUSES = r"PublicInvest|Public Investment Bank|RHB|Kenanga|MIDF|Hong Leong|HLIB|Maybank|CGS|TA Securities|TA Research|AmInvest(?:ment)?|Apex|BIMB|UOB|Mercury|Phillip|Inter-Pacific|Rakuten|Tradeview|大众投资银行|大众投行|马六甲证券|兴业投资银行|丰隆投资银行|肯纳格|马银行|联昌|艾芬|达证券|大马投资银行|大马投行|乐天|丰隆|兴业"
# 同一家研究行的中英文/全简称归一，避免重复（如 大众投资银行 = PublicInvest）
HOUSE_ALIASES = [
    ["PublicInvest", "Public Investment Bank", "大众投资银行", "大众投行"],
    ["RHB", "兴业投资银行", "兴业"], ["HLIB", "Hong Leong", "丰隆投资银行", "丰隆"],
    ["Kenanga", "肯纳格"], ["Maybank", "马银行"], ["CGS", "联昌"],
    ["TA", "TA Securities", "TA Research", "达证券"], ["AmInvest", "AmInvestment", "大马投资银行", "大马投行"],
    ["Rakuten", "乐天"], ["Malacca", "马六甲证券"], ["Affin", "艾芬"], ["Tradeview"],
]


def canon_house(s):
    if not s:
        return ""
    low = s.lower()
    for g in HOUSE_ALIASES:
        if any(a.lower() == low for a in g):
            return g[0]
    return s


def klse_quote(code):
    # Yahoo 抓不到时的后备：从 KLSE Screener 个股页抓现价（用数字代码）
    html = http_get("https://www.klsescreener.com/v2/stocks/view/" + urllib.parse.quote(code), timeout=20)
    m = re.search(r'id="price-fixed"[^>]*data-value="([\d.]+)"', html, re.I)
    if not m:
        return None
    nm = re.search(r"<title>\s*([^:<]+?)\s*:", html, re.I)
    return {"price": float(m.group(1)), "name": nm.group(1).strip() if nm else None, "source": "klse"}


def parse_klse_codes(page):
    # 从 KLSE Screener IPO 页建「短名 -> 数字代码」对照表（如 SUM -> 0459）
    out = {}
    for code, short in re.findall(r'/v2/stocks/view/([0-9A-Z]+)">([^<]+)</a></h4>', page, re.I):
        out[short.strip().upper()] = code
    return out


def target_from_body(t):
    # 从「单篇文章正文」里抽目标价：要求「目标价/合理价/fair value」紧贴数字，
    # 避免误抓发售价/盈利等无关数字（给顾客看的，宁可漏掉也不能错）
    for p in (r"(?:目标价|合理价|公平价值)[^0-9]{0,10}(\d+(?:\.\d+)?)\s*(仙|sen|令吉)?",
              r"(?:fair value|target price)[^0-9]{0,10}(?:RM\s*)?(\d+(?:\.\d+)?)\s*(仙|sen|令吉)?",
              r"(\d+(?:\.\d+)?)\s*(仙|sen)\s*(?:的)?(?:目标价|合理价|fair value|target price)"):
        m = re.search(p, t, re.I)
        if m:
            v = float(m.group(1))
            u = (m.group(2) or "").lower()
            return "%.2f" % (v / 100 if u in ("仙", "sen") or (u == "" and v >= 5) else v)
    # 「同等/相同目标价」= 跟 IPO 发售价一样
    if re.search(r"(?:同等|相同)\s*目标价|目标价[^0-9]{0,8}(?:同等|相同)|equal[^.]{0,15}(?:target|fair value)", t, re.I):
        m = re.search(r"(\d+(?:\.\d+)?)\s*仙\s*(?:的)?(?:发售价|新股|IPO)", t) or \
            re.search(r"(?:发售价|IPO price)[^0-9]{0,8}(?:RM)?\s*(\d+(?:\.\d+)?)", t, re.I)
        if m:
            v = float(m.group(1))
            return "%.2f" % (v / 100 if v >= 5 else v)
    return ""


def oversub_from_news(page):
    # 从新闻标题抓超额认购倍数（iSaham 字段更新慢/不更新，新闻先有），优先精确小数
    titles = squash(strip_tags(" || ".join(re.findall(r'<h2 class="figcaption"><a[^>]*>([^<]+)</a>', page))))
    for p in (r"oversubscribed\s*(?:by\s*)?(\d+\.\d+)\s*times", r"超额认购\s*(\d+\.\d+)\s*倍",
              r"oversubscribed\s*(?:by\s*)?(\d+)\s*times", r"超额认购\s*(?:近|逾|约)?\s*(\d+)\s*倍"):
        m = re.search(p, titles, re.I)
        if m:
            return m.group(1) + "x"
    return ""


def collect_news(stock_code):
    # 抓某只股的新闻：所有研究行目标价（点进正文）+ 超额认购倍数（从标题）。best-effort
    # 抓 2 页：IPO 上市当天大量新闻会把几天前的研报挤到第 2 页
    page = http_get(KLSE_NEWS_URL + stock_code)
    try:
        page += http_get(KLSE_NEWS_URL + stock_code + "/2")
    except Exception:
        pass
    out, seen, fetched = [], set(), 0
    for m in re.finditer(r'<h2 class="figcaption"><a[^>]*href="(/v2/news/view/[^"]+)"[^>]*>([^<]+)</a>', page):
        if fetched >= 6:
            break
        chunk = squash(strip_tags(page[m.start():m.start() + 500]))  # 标题 + 摘要，判断要不要点进去
        if not re.search(RESEARCH_HOUSES, chunk, re.I) and not re.search(TARGET_KW, chunk, re.I):
            continue
        fetched += 1
        try:
            body = squash(strip_tags(http_get("https://www.klsescreener.com" + m.group(1))))
        except Exception:
            continue
        price = target_from_body(body)
        if not price:
            continue
        hm = re.search(RESEARCH_HOUSES, body, re.I)
        source = canon_house(hm.group(0) if hm else "")
        key = source or price  # 同一家研究行只取最新一篇
        if key in seen:
            continue
        seen.add(key)
        out.append({"price": price, "source": source,
                    "headline": squash(strip_tags(m.group(2))),
                    "url": "https://www.klsescreener.com" + m.group(1)})
    return {"targets": out, "oversub": oversub_from_news(page)}


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
            # 1) 先试 Yahoo
            try:
                url = "https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(s)
                meta = json.loads(http_get(url, timeout=20))["chart"]["result"][0]["meta"]
                price = meta.get("regularMarketPrice")
                if price and price > 0:
                    out[s] = {
                        "price": price,
                        "prevClose": meta.get("chartPreviousClose"),
                        "name": meta.get("longName") or meta.get("shortName"),
                        "time": meta.get("regularMarketTime"),
                        "source": "yahoo",
                    }
                    continue
            except Exception:
                pass
            # 2) Yahoo 没有 -> 自动转 KLSE Screener
            try:
                q = klse_quote(s.replace(".KL", "").replace(".kl", ""))
                if q:
                    out[s] = q
                    continue
            except Exception:
                pass
            out[s] = {"error": "no price from Yahoo or KLSE"}
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
                if r["stockCode"]:  # 从新闻抓目标价 + 超额认购（best-effort）
                    try:
                        n = collect_news(r["stockCode"])
                        if n["targets"]:
                            r["targets"] = n["targets"]  # [{price, source, headline, url}, ...]
                        if not r.get("oversub") and n["oversub"]:
                            r["oversub"] = n["oversub"]  # iSaham 字段空时用新闻的真实倍数
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
