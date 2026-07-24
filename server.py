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
KLSE_IPO_URL = "https://www.klsescreener.com/v2/ipos"  # KLSE Screener IPO 列表（2026-07 起改成主来源，iSaham 被 Cloudflare 锁死）
WORKER_VERSION = "v12-klse-source"  # 部署后 /api/ipos 会返回它，一看就知道线上跑的是哪版
KLSE_NEWS_URL = "https://www.klsescreener.com/v2/news/stock/"  # 个股完整新闻列表（找研究行目标价）
TARGET_KW = r"fair value|target price|\bTP\b|合理价|目标价|公平价值"  # 目标价关键词（中英）
RESEARCH_HOUSES = r"PublicInvest|Public Investment Bank|RHB|Kenanga|MIDF|Hong Leong|HLIB|Maybank|CGS|TA Securities|TA Research|AmInvest(?:ment)?|Apex|BIMB|UOB|Mercury|Phillip|Inter-Pacific|Malacca Securities|Malacca|Rakuten|Tradeview|大众投资银行|大众投行|马六甲证券|兴业投资银行|丰隆投资银行|肯纳格|马银行|联昌|艾芬|达证券|大马投资银行|大马投行|乐天|丰隆|兴业"
MULTI_STOCK_TITLE = r"trading idea|stocks? (to|on|in) watch|stocks? on radar|market roundup|交易灵感|交易点子|焦点股|每日焦点|热门股"  # 一次讲多只股的文章，跳过以免张冠李戴
RESEARCHY_TITLE = r"poised|prospects?|outlook|upside|undervalu|initiat|coverage|fair value|target price|合理价|目标价|看好|前景|潜在涨"  # 研报式标题也当候选（投行名字可能藏在文章后段）
# 同一家研究行的中英文/全简称归一，避免重复（如 大众投资银行 = PublicInvest）
HOUSE_ALIASES = [
    ["PublicInvest", "Public Investment Bank", "大众投资银行", "大众投行"],
    ["RHB", "兴业投资银行", "兴业"], ["HLIB", "Hong Leong", "丰隆投资银行", "丰隆"],
    ["Kenanga", "肯纳格"], ["Maybank", "马银行"], ["CGS", "联昌"],
    ["TA", "TA Securities", "TA Research", "达证券"], ["AmInvest", "AmInvestment", "大马投资银行", "大马投行"],
    ["Rakuten", "乐天"], ["Malacca", "Malacca Securities", "马六甲证券"], ["Affin", "艾芬"], ["Tradeview"],
]


def canon_house(s):
    if not s:
        return ""
    low = s.lower()
    for g in HOUSE_ALIASES:
        if any(a.lower() == low for a in g):
            return g[0]
    return s


def div_history(symbol):
    # 历史股息（近5年）：给「顾客持有期间的股息」自动补记用
    import time
    p2 = int(time.time())
    p1 = p2 - 5 * 365 * 24 * 3600
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(symbol)
           + "?period1=%d&period2=%d&interval=1d&events=div" % (p1, p2))
    res = json.loads(http_get(url, timeout=25))["chart"]["result"][0]
    evs = (res.get("events") or {}).get("dividends") or {}
    out = []
    for e in evs.values():
        if e.get("amount", 0) > 0:
            out.append({
                "exDate": __import__("datetime").datetime.utcfromtimestamp(e["date"]).strftime("%Y-%m-%d"),
                "dps": e["amount"],
            })
    return sorted(out, key=lambda d: d["exDate"])


def split_history(symbol):
    # 红股/拆股（近5年）：给「持仓自动调整股数」用
    import time
    p2 = int(time.time())
    p1 = p2 - 5 * 365 * 24 * 3600
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(symbol)
           + "?period1=%d&period2=%d&interval=1d&events=split" % (p1, p2))
    res = json.loads(http_get(url, timeout=25))["chart"]["result"][0]
    evs = (res.get("events") or {}).get("splits") or {}
    out = []
    for e in evs.values():
        num, den = e.get("numerator", 0), e.get("denominator", 0)
        if num > 0 and den > 0 and num != den:
            out.append({
                "exDate": __import__("datetime").datetime.utcfromtimestamp(e["date"]).strftime("%Y-%m-%d"),
                "factor": num / den,
                "ratio": e.get("splitRatio") or ("%s:%s" % (num, den)),
            })
    return sorted(out, key=lambda d: d["exDate"])


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
    # 从新闻标题抓超额认购倍数（iSaham 字段更新慢/不更新，新闻先有）
    # 同一只股不同标题可能写 7.77 或圆整的 7.8 —— 取「小数位最多」那个（最精确）
    titles = squash(strip_tags(" || ".join(re.findall(r'<h2 class="figcaption"><a[^>]*>([^<]+)</a>', page))))
    nums = re.findall(r"(?:oversubscribed\s*(?:by\s*)?|超额认购\s*(?:近|逾|约)?\s*)(\d+(?:\.\d+)?)\s*(?:times|倍)", titles, re.I)
    nums += re.findall(r"(\d+(?:\.\d+)?)\s*(?:times|倍)\s*(?:的)?(?:oversubscrib\w*|超额认购|超购)", titles, re.I)
    if not nums:
        return ""
    nums.sort(key=lambda n: len(n.split(".")[1]) if "." in n else 0, reverse=True)
    return nums[0] + "x"


def fmt_oversub(s):
    # 超额认购统一成两位小数：7.8x -> 7.80x，26.92x -> 26.92x，空的保持空
    m = re.search(r"(\d+(?:\.\d+)?)", s or "")
    return "%.2fx" % float(m.group(1)) if m else ""


def collect_news(stock_code):
    # 抓某只股的新闻：所有研究行目标价（点进正文）+ 超额认购倍数（从标题）。best-effort
    # 抓 2 页：IPO 上市当天大量新闻会把几天前的研报挤到第 2 页
    page = http_get(KLSE_NEWS_URL + stock_code)
    try:
        page += http_get(KLSE_NEWS_URL + stock_code + "/2")
    except Exception:
        pass
    out, seen, fetched, orig_fetched = [], set(), 0, 0
    for m in re.finditer(r'<h2 class="figcaption"><a[^>]*href="(/v2/news/view/[^"]+)"[^>]*>([^<]+)</a>', page):
        if fetched >= 6:
            break
        title = squash(strip_tags(m.group(2)))
        if re.search(MULTI_STOCK_TITLE, title, re.I):  # 跳过一次讲多只股的文章
            continue
        chunk = squash(strip_tags(page[m.start():m.start() + 500]))  # 标题 + 摘要，判断要不要点进去
        if not re.search(RESEARCH_HOUSES, chunk, re.I) and not re.search(TARGET_KW, chunk, re.I) \
                and not re.search(RESEARCHY_TITLE, title, re.I):
            continue
        fetched += 1
        try:
            raw_art = http_get("https://www.klsescreener.com" + m.group(1))
        except Exception:
            continue
        body = squash(strip_tags(raw_art))
        price = target_from_body(body)
        # KLSE Screener 有些文章只是节选（TheStar snapshot），数字被截掉——跟去原文抓（每股最多2次）
        if not price and orig_fetched < 2 and re.search(RESEARCH_HOUSES, body, re.I):
            om = re.search(r'href="(https?://www\.thestar\.com\.my[^"]+)"', raw_art, re.I)
            if om:
                orig_fetched += 1
                orig_url = re.sub(r"^http:", "https:", om.group(1))
                # TheStar 挡 Cloudflare 机房：先直连，不行就走 r.jina.ai 文字镜像（实测能读到全文）
                for u in (orig_url, "https://r.jina.ai/" + orig_url):
                    try:
                        ot = squash(strip_tags(http_get(u)))
                        p2 = target_from_body(ot)
                        if p2:
                            price = p2
                            body = ot  # 投行名字也从原文认
                            break
                    except Exception:
                        pass
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


MON3 = {"Jan": "01", "Feb": "02", "Mar": "03", "Apr": "04", "May": "05", "Jun": "06",
        "Jul": "07", "Aug": "08", "Sep": "09", "Oct": "10", "Nov": "11", "Dec": "12"}


def parse_ipos(page):
    # 从 KLSE Screener /v2/ipos 解析即将上市的 ACE / Main 公司（iSaham 2026-07 起被 Cloudflare 锁死，改用这里）
    today = __import__("datetime").date.today().isoformat()
    rows = []
    for c in re.split(r'<div class="card mb-3', page)[1:]:
        yr = re.search(r'title="(20\d\d)"', c)
        mo = re.search(r'text-uppercase">([A-Z][a-z]{2})', c)
        dy = re.search(r"<h3>(\d{1,2})</h3>", c)
        cm = re.search(r'/v2/stocks/view/([0-9A-Z]+)">([^<]+)</a></h4><span[^>]*>([^<]+)</span>', c)
        board = re.search(r"Board:\s*</span>\s*<strong>([^<]+)", c)
        if not (yr and mo and dy and cm and board):
            continue
        iso = "%s-%s-%s" % (yr.group(1), MON3.get(mo.group(1), "00"), dy.group(1).zfill(2))
        bd = board.group(1).strip()
        if iso < today or ("ACE" not in bd and "Main" not in bd):  # 只要未上市的 ACE / Main
            continue
        close = re.search(r"Close:</span>\s*([0-9]{1,2}\s[A-Za-z]{3})", c)
        sec = re.search(r"Sector:\s*</span>\s*<strong>([^<]+)", c)
        sub = re.search(r"Sub sector:\s*</span>\s*<strong>([^<]+)", c)
        price = re.search(r">\s*([0-9]+\.[0-9]{1,3})\s*</", c[cm.end():])
        biz = squash(strip_tags(sec.group(1))) if sec else ""
        if sub:
            biz += " · " + squash(strip_tags(sub.group(1)))
        rows.append({
            "stockCode": cm.group(1),
            "code": cm.group(2).strip(),
            "name": squash(strip_tags(cm.group(3))),
            "market": "Main" if "Main" in bd else "ACE",
            "price": "%.2f" % float(price.group(1)) if price else "",
            "listingDate": "%s-%s-%s" % (dy.group(1).zfill(2), mo.group(1), yr.group(1)),
            "closeDate": (close.group(1).replace(" ", "-") + "-" + yr.group(1)) if close else "",
            "oversub": "",
            "business": biz,
        })
    return rows


def http_get(url, timeout=40, referer=None):
    hdrs = {"User-Agent": UA}
    if referer:
        hdrs["Referer"] = referer
    req = urllib.request.Request(url, headers=hdrs)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


# ---- 个股企业行动：主源 Pick@Stock（持牌 Bursa 数据），i3investor 交叉核对 ----
# i3 把「免费凭单」也标成 BONUS_ISSUE，跟真红股分不出来（EDELTEQ / MINOX / RAMSSOL / GCB 都中招），
# 照它跑会平白给客户多加股票。Pick@Stock 明确分开 "Bonus Issue" 和 "Bonus Issue (Warrants)"。
PAS_ENT_URL = "https://www.pickastock.info/api/Entitlement/"
I3_ENT_URL = "https://klse.i3investor.com/web/stock/entitlement/"
PAS_SYMBOLS_URL = "https://www.pickastock.info/api/TimeNSales/MainAceSymbol"
_live_symbols = None


def live_symbols():
    """现在还在市的全部 counter。用来判断凭单到期了没有。
    不能用「KLSE Screener 抓不抓得到价格」判断——它连早就下市的凭单也照回旧价（GCB-WA 实测）。"""
    global _live_symbols
    if _live_symbols is None:
        _live_symbols = set(json.loads(http_get(PAS_SYMBOLS_URL, referer="https://www.pickastock.info/")).keys())
    return _live_symbols


def warrant_per_share(ratio):
    """免费凭单「X : Y」= 每持 Y 股送 X 张（EDELTEQ 1:2 = 0.5，已对 Bursa 公告原文）"""
    try:
        p = [float(x) for x in str(ratio or "").split(":")]
    except ValueError:
        return None
    return p[0] / p[1] if len(p) == 2 and p[0] > 0 and p[1] > 0 else None


def i3_is_warrant(detail_path):
    """i3 只写 BONUS_ISSUE、分不出股票还是凭单时，去详情页读 Bursa 公告原文。
    返回 True=凭单 / False=真红股 / None=断不出（交给用户人工看）"""
    if not detail_path:
        return None
    try:
        page = http_get("https://klse.i3investor.com" + detail_path, referer="https://klse.i3investor.com/")
    except Exception:
        return None
    txt = re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", page))
    if re.search(r"free warrants?|bonus issue of .{0,40}warrants?|warrants? for every", txt, re.I):
        return True
    if re.search(r"bonus issue of .{0,60}(ordinary )?shares?", txt, re.I):
        return False
    return None


def iso_from_dmy(s):        # "10-Mar-2026" -> "2026-03-10"
    p = s.split("-")
    return "%s-%s-%s" % (p[2], MON3[p[1]], p[0].zfill(2)) if len(p) == 3 and p[1] in MON3 else ""


def iso_from_dmony(s):      # "10 Mar 2026" -> "2026-03-10"
    p = str(s).strip().split()
    return "%s-%s-%s" % (p[2], MON3[p[1]], p[0].zfill(2)) if len(p) == 3 and p[1] in MON3 else ""


def ratio_factor(kind, ratio):
    try:
        p = [float(x) for x in str(ratio or "").split(":")]
    except ValueError:
        return None
    if len(p) != 2 or p[0] <= 0 or p[1] <= 0:
        return None
    return p[0] / p[1] if kind == "split" else (p[0] + p[1]) / p[1]


def classify_pas(t):
    """归类 Pick@Stock 的 EntitlementType。返回 None = 现金股息，直接跳过。"""
    t = str(t or "").upper()
    if "WARRANT" in t or "RIGHT" in t or "SPECIE" in t:
        return (None, False)                       # 凭单 / 附加股 / 派别家股票 -> 股数不变
    if "CONSOLIDAT" in t or "SPLIT" in t or "SUBDIVI" in t:
        return ("split", True)
    if "BONUS" in t or "SHARE DIVIDEND" in t:
        return ("bonus", True)
    if "DIVIDEND" in t or "DISTRIBUTION" in t or "CAPITAL REPAYMENT" in t:
        return None
    return (None, False)                           # "Others" 等含糊类别 -> 靠 i3 判


def i3_entitlements(code):
    try:
        page = http_get(I3_ENT_URL + urllib.parse.quote(code))
    except Exception:
        return []
    m = re.search(r"var dtdata = (\[.*?\]);", page, re.S)
    if not m:
        return []
    out = []
    for r in json.loads(m.group(1)):
        t = str(r[2] or "").upper()
        ex = iso_from_dmy(str(r[1] or ""))
        if ex and t != "DIVIDEND":
            out.append({"exDate": ex, "annDate": iso_from_dmy(str(r[0] or "")),
                        "type": t, "subject": str(r[3] or ""), "ratio": str(r[4] or "").strip(),
                        "detail": str(r[5] or "")})
    return out


def corp_actions(code):
    items = json.loads(http_get(PAS_ENT_URL + urllib.parse.quote(code) + "?page=1&rows=200",
                                referer="https://www.pickastock.info/")).get("items") or []
    i3 = i3_entitlements(code)
    i3_by_date = {}
    for e in i3:
        i3_by_date.setdefault(e["exDate"], e)

    out, seen = [], set()
    for it in items:
        ex = iso_from_dmony(it.get("ExDate") or "")
        if not ex:
            continue
        cls = classify_pas(it.get("EntitlementType"))
        if cls is None:
            continue
        kind, auto = cls
        ratio = str(it.get("Ratio") or "").strip()
        if not kind and ratio:                     # Pick@Stock 用 "Others" 装拆股，问 i3 同一天是什么
            pt = (i3_by_date.get(ex) or {}).get("type", "")
            if "SPLIT" in pt or "CONSOLIDAT" in pt:
                kind, auto = "split", True
        factor = ratio_factor(kind, ratio) if kind else None
        seen.add(ex)
        is_w = "WARRANT" in str(it.get("EntitlementType") or "").upper()
        out.append({"exDate": ex, "annDate": iso_from_dmony(it.get("AnnDate") or ""),
                    "type": str(it.get("EntitlementType") or ""),
                    "subject": str(it.get("EntitlementDesc") or it.get("EntitlementType") or ""),
                    "ratio": ratio, "factor": factor, "source": "pickastock",
                    "ref": it.get("ReferenceUrl") or "",
                    "autoApply": bool(auto and factor and factor != 1), "needCheck": False,
                    "isWarrant": is_w, "perShare": warrant_per_share(ratio) if is_w else None})

    for e in i3:      # i3 有、Pick@Stock 没有 -> 读公告原文断是股票还是凭单；断不出才丢给用户
        if e["exDate"] in seen:
            continue
        w = i3_is_warrant(e["detail"]) if ("BONUS" in e["type"] or "WARRANT" in e["type"]) else None
        out.append({"exDate": e["exDate"], "annDate": e["annDate"], "type": e["type"],
                    "subject": e["subject"], "ratio": e["ratio"],
                    "factor": ratio_factor("bonus", e["ratio"]) if w is False else None,
                    "source": "i3investor" if w is None else "i3investor+announcement",
                    "ref": "", "autoApply": False, "needCheck": w is None,
                    "isWarrant": w is True,
                    "perShare": warrant_per_share(e["ratio"]) if w is True else None})
    out.sort(key=lambda x: x["exDate"])

    # 凭单代号：Bursa 惯例是母股代码 + WA/WB/WC…，按送出的先后排。到期的不算持仓 -> 查在市名单。
    base = str(items[0].get("Symbol") or "").upper() if items else ""
    w_events = [x for x in out if x["isWarrant"] and (x["perShare"] or 0) > 0]
    if base and w_events:
        try:
            live = live_symbols()
        except Exception:
            live = None
        for i, e in enumerate(w_events):
            letter = chr(65 + i)                   # 第1次送 -> WA，第2次 -> WB…
            e["warrantSymbol"] = "%s-W%s" % (base, letter)
            e["warrantCode"] = "%sW%s" % (code, letter)
            e["warrantLive"] = (e["warrantSymbol"] in live) if live is not None else None
    return out


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/api/quotes"):
            self.handle_quotes()
        elif self.path.startswith("/api/divhistory"):
            self.handle_divhistory()
        elif self.path.startswith("/api/splits"):
            self.handle_splits()
        elif self.path.startswith("/api/corpactions"):
            self.handle_corpactions()
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

    def handle_splits(self):
        qs = urllib.parse.urlparse(self.path).query
        symbols = urllib.parse.parse_qs(qs).get("symbols", [""])[0].split(",")
        out = {}
        for s in symbols[:60]:
            s = s.strip().upper()
            if not s:
                continue
            try:
                out[s] = split_history(s)
            except Exception as e:
                out[s] = {"error": str(e)}
        self.send_json(out)

    def handle_corpactions(self):
        qs = urllib.parse.urlparse(self.path).query
        codes = urllib.parse.parse_qs(qs).get("codes", [""])[0].split(",")
        out = {}
        for c in codes[:60]:
            c = c.strip()
            if not c:
                continue
            try:
                out[c] = corp_actions(c)
            except Exception as e:
                out[c] = {"error": str(e)}
        self.send_json({"version": "local-v16-pickastock", "data": out})

    def handle_divhistory(self):
        qs = urllib.parse.urlparse(self.path).query
        symbols = urllib.parse.parse_qs(qs).get("symbols", [""])[0].split(",")
        out = {}
        for s in symbols[:60]:
            s = s.strip().upper()
            if not s:
                continue
            try:
                out[s] = div_history(s)
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
            page = http_get(KLSE_IPO_URL)  # KLSE Screener /v2/ipos（主来源）
            # 抓取失败 / 被挡：页面里连一个 IPO 卡都没有 -> 报错，不要冒充「0 家」
            if "/v2/stocks/view/" not in page:
                self.send_json({"error": "IPO source unavailable (blocked or changed)"}, status=502)
                return
            rows = parse_ipos(page)
            for r in rows:
                try:
                    n = collect_news(r["stockCode"])  # 目标价 + 超额认购
                    if n["targets"]:
                        r["targets"] = n["targets"]
                    if not r.get("oversub") and n["oversub"]:
                        r["oversub"] = n["oversub"]
                except Exception:
                    pass
                if r.get("oversub"):
                    r["oversub"] = fmt_oversub(r["oversub"])
            self.send_json({"source": KLSE_IPO_URL, "version": WORKER_VERSION, "rows": rows})
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
