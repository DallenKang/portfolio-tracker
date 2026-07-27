# 给 Codex 用的资料夹

## 怎么用（在另一台电脑）

```bash
git clone https://github.com/DallenKang/portfolio-tracker.git
cd portfolio-tracker
```

这样就全有了 —— 不需要 USB、不需要 OneDrive、不需要传档案。

然後对 Codex 说：

> 先读 AGENTS.md 和 codex/ 里的档案，再开始。

---

## 这里面有什么

| 档案 | 内容 | 谁更新 |
|---|---|---|
| `../AGENTS.md` | **Codex 会自动读**。专案架构、绝对不能碰的东西、踩过的坑、部署铁律 | 架构有变才更新 |
| `进度快照.md` | 做完了什么、还剩什么 | 每次交接前更新 |
| `本次任务.md` | 这次要 Codex 做什么 | 每次交接前写 |

---

## 为什么这里面没有密钥和投资者姓名

这个资料夹会上传到 **GitHub 公开 repo**，所以：

- ❌ 不放：後备主密钥、Apps Script 网址、投资者姓名/电话/代号
- ✅ 放：架构说明、进度、任务、踩过的坑

**Codex 要看线上真实资料时**，用後备主密钥读（方法写在 `AGENTS.md`）。
密钥在你自己电脑的 `搬家步骤-InnerCircle.txt` 最下面，**要用时手打，不要放进任何会上传的档案**。

---

## 在别人的电脑上工作要注意

- 登入 Google 用**无痕视窗**，用完**登出**
- 那个 gmail 户口管着所有投资者的资料和整个後端
- 不要下载 `portfolio-backup-*.json`（含真实投资者资料）
