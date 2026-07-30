# AGENTS.md — Inner Circle Ptracker

**读这份之前先知道三件事：**
1. 这是**正在营运的生产系统**，有真实用户和真实财务资料。
2. 使用者 Dallen **不是程序员** —— 他无法检查你的代码或结论。「自信但讲错」在这里是最严重的失败。用中文回覆他，讲效果不讲实现细节。
3. 详细进度看 `进度总表-InnerCircle.md`（同资料夹，不在 git 里）。

---

## 这是什么

马来西亚股票组合追踪系统。使用者输入买卖记录，系统算出持仓、成本、已实现/未实现盈亏、股息、企业行动、现金流。

| | |
|---|---|
| 生产网址 | https://innercircleptracker.com/portfolio-tracker.html |
| 条款页 | https://innercircleptracker.com/terms.html |
| 使用者 | Dallen（管理者）+ 他的投资者 + 已对大众开放注册 |
| 目前规模 | 7 位投资者、200+ 笔交易 |

**三级权限**：super（看全部+管员工）／staff（只看被指派的投资者）／client（只看自己）。
权限由**後端** `guardStaffSave` 强制，前端隐藏只是表面功夫。

---

## 🔴 绝对不要做的事

1. **不要改费用与损益公式**，除非 Dallen 明确要求且你已说明影响。
   `calcFees()`、`computePortfolio()`、`netAmount()` **已逐行对过他的真实 Excel**。
   费率规则：brokerage = gross × 每位投资者的 rate（有最低收费）；印花税 = 每 RM1,000 收 RM1.00（**无条件进位到千**，上限 RM1,000）；交收费 = gross × 0.03%（**无条件进位到分**，上限 RM1,000）。买入 net = gross + 费用，卖出 net = gross − 费用。

2. **不要在未经他同意的情况下 `git push`。** 生产网站会立刻更新。

3. **不要删除或清空任何资料**，也不要碰 `.gitignore` 里的忽略规则。

4. **不要把这些档案加进 git**：`apps-script.gs`（含主密钥）、`portfolio-backup-*.json`（真实投资者资料）、`搬家步骤-*.txt`、`域名步骤-*.txt`、`进度总表-*.md`、`CLAUDE.md`。

5. **不要重构 `clientId` / `db.clients` / `clientById` 这些内部名称。** 介面上已统一称「投资者 Investors」，但资料层刻意保留旧名 —— 改了要连後端 Google Sheet 的栏位一起改，风险高且使用者看不到。

6. **不要宣称「完成/没有/全部」除非你有证据**（指令输出、截图、实际验证）。只查了一部分就说清楚查了哪部分。

---

## 档案地图

| 档案 | 是什么 | 改了怎么生效 |
|---|---|---|
| `portfolio-tracker.html` | **单档前端**，2000+ 行，HTML+CSS+JS 全在里面 | `git push` → GitHub Pages 自动上线（约 1–5 分钟）|
| `apps-script.gs` | **後端**（Google Apps Script）。**不在 git**，只在本机 | 见下方「後端部署铁律」|
| `worker.js` | Cloudflare Worker，抓股价与企业行动 | **改本机档案没用**，要手动贴进 Cloudflare dashboard → Deploy |
| `server.py` | 本机开发用的 server（port 8745），镜像 worker 的 API | `start-tracker.bat` 启动 |
| `terms.html` | 条款页（英文为准，中文仅参考）| 跟前端一起 push |

**资料流**：浏览器 localStorage（本机副本）↔ Apps Script ↔ Google Sheet（真正的资料库）。
Worker 只抓公开市场数据，**不碰使用者资料**。

---

## ⚠️ 後端部署铁律（踩过 3 次的坑）

改 `apps-script.gs` 之後：

```
1. 复制本机档案全文 → 贴进 script.google.com 编辑器 → 储存
2. 部署 → 【管理部署作业】→ ✏️ 编辑 → 版本选【新版本】→ 部署
```

- **千万不要按「新增部署作业」** —— 那会产生**新网址**，前端 `SHEET_URL` 就断了。
- **储存 ≠ 上线。** 一定要走部署那一步。
- 用到新的 Google 权限范围时，要先在编辑器跑一次 `authorizeMe()` 授权。

同理，改了 `worker.js` 一定要提醒 Dallen 去 Cloudflare 贴 —— 改本机档案对线上零影响。
贴完测 `/api/ipos`，回传的 `version` 栏位就是线上跑的版本（目前 `v18-warrants`）。

---

## 已知的坑（都真实发生过）

**资料正确性**
- **i3investor 会把「免费凭单 bonus issue of WARRANTS」标成 `BONUS_ISSUE`**，跟真红股一模一样。照它跑会平白多给投资者 50% 股票。→ 现在以 Pick@Stock 为主源（它区分 "Bonus Issue" 和 "Bonus Issue (Warrants)"），i3 只当交叉核对。
- **附加股(Rights Issue)附送的凭单要出钱认购**，不是白拿的，不能自动发给使用者。
- **同一天可能有多个企业行动**（例：PHARMA 2013-05-31 同时有红股 1:10 和拆股 2:1）。只按日期比对会漏掉第二个，导致股数少一半。要用「日期+比例」配对。
- **KLSE Screener 对早已下市的凭单仍回传旧价格** → 判断凭单是否还在市要查 Pick@Stock 的在市 symbol 表，不能用「有没有价格」判断。
- 验证红股真假的硬办法：看除权日**未调整**收盘价的跌幅，对不上倍数就不是送股。

**同步与状态**
- **Google ID token 约 1 小时过期。** 过期後自动存档会一直失败；旧版失败後不重试，使用者以为有存其实全在本机。→ 现在存档前会检查 `exp` 并预先换凭证，失败会记 `pendingRetry` 并在下次登入成功後自动补存。
- **localStorage 是按网址分开存的。** 换网址／换电脑第一次开是空的 —— 那**不是资料丢了**，登入一次就会从云端载回来。别急着叫使用者重新输入。
- 前端有「查不到资料」被显示成「没问题」的历史 bug。**任何批次抓取失败都必须明确讲出来**，不能静默跳过。

**其他**
- PowerShell 是 5.1：**没有 `&&` 和 `||`**，链式用 `;` 或 `if ($?)`。
- Windows 主控台是 cp1252：**Python/server.py 的 `print()` 不要输出中文**，会崩。
- port 8745 有僵尸进程时改了 `server.py` 不会生效 → `start-tracker.bat` 会自动杀掉旧的。
- 改 DOM 的排序功能不能用布林旗标防 `MutationObserver` 重入（回呼是非同步的，会无限循环）→ 要 `disconnect()` 再 `observe()`。

---

## 怎么验证你的改动（不要只靠推理）

**读线上真实资料**（唯读，安全）：用 `搬家步骤-InnerCircle.txt` 里的後备主密钥，POST 到 Apps Script 网址：
```
{ "token": "<主密钥>", "action": "load" }
```
回传含 clients / transactions / dividends / staff。**读可以，写要先问 Dallen。**

**确认前端上线了**：抓生产网址的 HTML，搜寻你刚加的关键字串。GitHub Pages 有时要几分钟。

**本机预览**：`start-tracker.bat` → http://localhost:8745/portfolio-tracker.html
（Google 登入在 localhost 可以用，`http://localhost:8745` 已加进 OAuth 授权来源。）

**给 Dallen 的连结**：改动後回覆结尾**必须**附可点击连结。给之前先确认 server 真的在跑。

---

## 目前待办

1. 6 位原有投资者的 `phone` 栏还是空的 —— **发注册链接给他们之前一定要先填**，否则他们注册时对不上号码，会开成全新空白户口、看不到自己的交易记录
3. 其余见 `进度总表-InnerCircle.md`
