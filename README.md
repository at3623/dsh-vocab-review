# dsh-vocab-review

**上传一张划线的单词表图片，插件就把它变成逐词抽查；没有划线的文章图片，它会挑出文章里的考试高频词（高考/CET-4/CET-6/考研）加进词库。**
[中文文档](#中文文档) · [English docs](#english-docs)

DeepSeek Harness（DSH）插件 · 零运行时依赖 · 数据只在本机 · 可选内置 QQ 机器人
会 / 半会 / 不会三档判定 · 模型判对也会被插件复核 · 薄弱词本可导出 CSV/JSON/Anki · 文章图片按考试高频收词 · 间隔随表现微调

---

## 中文文档

### 核心功能：图片导入，不用手打单词

这是这个插件最省事的地方：**你只需要上传图片，不用整理词表、不用抄单词、不用管错词本。**

1. 在对话里直接上传一张单词表 / 试卷 / 作业 / 阅读材料的图片。
2. 聊天模型读图，只挑出**划线的英文单词**，并统一还原成原形（`ran → run`、`benefits → benefit`、`studies → study`），去重后调用 `vocab_import`。**同一张图里出现的考试高频词（没划线的）也会一起收**：模型把它们放在同一个调用的 `extra` 字段里，插件照样过滤基础词、拒收 `:out` 超纲词、去重并按 `articleMaxWords` 限量，词条来源记为 `exam`；不想要这个行为就设 `includeHighFreq: false`。
3. 插件收到纯文本词表后：规范化 → 去重 → 标出高频/普通/低频 → 写进本地 `ledger.json`，并立刻出第一题。
4. **图片不会被插件读取、保存或上传**：插件没有 OCR、没有图片处理依赖，落盘的只有文字词表。

```text
你：[上传单词表图片]
模型：读图，只挑划线词 → vocab_import("abandon, benefit, cautious, ...")
插件：规范化 + 去重 + 排复习计划 → 存入 ledger.json
插件/模型：Q: abandon
你：放弃
模型：✅ abandon = 放弃        ← 只有这一行（三档：✅ / 🤔 / ❌）
插件：记录结果 + 安排下次复习 → Q: benefit
```

> **为什么强调"图片导入"**
>
> - 拍照/截图即可开工，一本书几十个划线词，一次导入，不用敲键盘。
> - 词表是**干净的原形列表**，不会因为图片里有中文、题号、页码、多列排版而变脏。
> - 图片本身不留在插件里：隐私可控，`ledger.json` 里只有 `word / meaning / dueAt / errors` 这类字段。
> - 也可以完全不用图片——直接发文字词表（例如 `abandon, benefit, cautious`）效果完全一样。
>
> **适用范围**：模型读图效果取决于图片清晰度；划线要能看清（直线划在词下最稳）。字迹模糊、双栏交错、整页密排时，识别可能漏词或多词，这时改用文字词表最稳。

### 没有划线的文章图片：只收文章里的「考试高频词」

试卷/单词表是「划线词全收」。普通文章、阅读理解、新闻截图**没有划线**，这时不该把整篇文章的词都塞进词库，也不该按「这篇里出现得多」来挑——要挑的是**考试高频词**：在高考/CET-4/CET-6/考研真题里反复出现、值得背的考点词。这条路径由 `vocab_import_article` 负责：

1. 在对话里上传文章图片（或直接把文章文字粘贴进来）。
2. 模型读文章，按**目标考试的词频**筛出里面的考试高频词（默认 CET-4，可在配置里改 `examLevel`；你说「考研/四级/六级/高考」时按你说的来），给核心高频词标 `:high`（间隔更短、问得更勤），把自己判断超纲/生僻的词标 `:out`，然后调用 `vocab_import_article`。
3. 插件再做几道筛：
   - **丢掉 `:out` 词**：模型标为超纲/生僻的词一律不进库；
   - **丢掉基础词**：`the / is / have / good / school` 这类内置基础词表里的词一律不收，免得词库被"小学词汇"灌满；
   - **去重 + 只留原形**；
   - **限流**：每次最多收 `articleMaxWords`（默认 20）个，超出的词在工具返回里列出来。
4. **不会自动开始考试**：插件先返回「收了哪几个、丢了哪几个基础词、哪几个超纲、哪几个因为超量没进」，模型回一两句话告诉你；你点 **开始复习** 或回「开始背单词」，才进入问答。

```text
你：[上传一篇没有划线的文章图片]
模型：读文章 → 按考试高频词筛 → vocab_import_article("abandon:cet4, benefit:high, quixotic:out, ...")
插件：丢 :out 词 + 丢基础词（the/is/school）+ 去重 + 最多 20 个 → 存入 ledger.json
模型：从这篇里挑了 12 个 CET-4 高频词：abandon, benefit, cautious …（abandon 是高频核心词）
你：开始背单词
插件：Q: abandon …
```

> 选词标准是**考试词频**，不是「在这篇文章里重复几次」。文章里反复出现但考试不考的专有名词/生僻词，模型会用 `:out` 标掉，插件也会拒收。
> 两种图片的分工：**划线图 = 你选好了，插件照收**；**文章图 = 模型按考试高频筛选、插件过滤基础词与超纲词、你确认后再背**。
> 一篇文章想多收点词就调大 `articleMaxWords`；考试范围用 `examLevel`（见配置表），或每次导入时直接说「给我考研高频词」。

### 一分钟上手

```powershell
# 从 GitHub 安装（需要 DSH 0.2.x、Node 22+）
dsh plugin --profile <profile> add github:at3623/dsh-vocab-review
```

或者：DSH → **插件** → **添加插件** → 选择本目录（本地目录安装）。

装好后：

1. 在任意对话里**上传图片**：划线单词表 → 导入划线词；没有划线的文章 → 导入里面的考试高频词。也可以直接粘贴文字词表。
2. 左侧栏点 **单词复习** 图标 → 选择「复习对话」→ 点 **开始复习**。
3. 在对话里按提示回答中文释义；答完一个，插件自动问下一个。不确定就直说「好像…」，那是 `🤔` 档，会提前回来重问。
4. 答错不要紧：错词进入错词池，按间隔阶梯自动回来重问；侧栏面板里能看到薄弱词本。

要求：DSH 0.2.x、Node 22+，**本插件本身没有任何 npm 运行时依赖**。QQ 通道可选，而且有两种接法：**内置 QQ**（你在面板里填 QQ 开放平台的 AppID/AppSecret，本插件自己连，不需要任何第三方插件）或**桥接 `@hualiong/dsh-qq-bot`**（如果你已经装了它）。详见下文「QQ 通道」与「依赖与第三方组件」。

### 依赖与第三方组件

**这个插件本身没有任何 npm 运行时依赖**：读图导入、词表调度、三档判定与复核、难度因子 ease、每日限额、到期提醒、侧栏面板、ledger 存储、CSV/JSON/Anki 导出，以及**内置 QQ 机器人**（QQ 开放平台鉴权、WebSocket 网关、收发消息、图片下载，用的是 Node 自带的 `fetch`/`WebSocket`），全部是本插件自己的代码（`index.js` + `client.js` + `qq/` + `locale/` + `icon.svg`）。

第三方插件 `@hualiong/dsh-qq-bot` 只是**可选的另一种接法**：如果你已经装了它，本插件也可以只做桥接（见下表）。两种 QQ 通道二选一，不要同时连同一个 AppID。

| 组件 | 来源 | 本插件怎么用它 | 边界 |
| --- | --- | --- | --- |
| **内置 QQ**（本插件自带） | 本仓库 `qq/client.js`、`qq/bridge.js`，零依赖 | 直连 QQ 开放平台：`bots.qq.com` 换 token → `api.sgroup.qq.com/gateway` 的 WebSocket → 收 `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE` → 文字/图片交给所选 DSH 会话 → 回复用被动消息或主动推送 | 需要你自己的机器人 AppID/AppSecret；AppSecret 明文存在本机 `settings.json`；一个机器人 App 只能有一个网关连接 |
| `@hualiong/dsh-qq-bot`（0.4.x，MIT） | 第三方社区插件，作者 hualiong，[GitHub](https://github.com/hualiong/dsh-qq-bot) | 只在**没配内置 QQ** 时作为回退：① 读它的状态文件 `<DSH_HOME>/integrations/dsh-qq-bot/state.json`（`sessionId`、`target`、`ownerOpenId`）；② 调用它注册的全局工具 `send_qq_message({ text })` | 不装它也能用 QQ（走内置）；不复制/不包含它的代码；不读它的 AppSecret；它的入站只支持文字 |

- 内置 QQ 的依赖接口只有两个公开协议：QQ 开放平台的 token/gateway/message REST 与 WebSocket（Node 22+ 自带，无 SDK）。
- 本插件的 `package.json` **不声明**对 `dsh-qq-bot` 的依赖，发布包里也没有任何第三方代码。
- `@hualiong/dsh-qq-bot` 自己依赖腾讯官方 `@tencent-connect/qqbot-*` 和 `qrcode`，这些依赖属于它、不属于本插件；本插件按它 0.4.2 的状态文件与 `send_qq_message` 工具验证过桥接模式。

### 复习是怎么跑起来的

答案由**插件**调度，模型只负责两件事：读图取词、批改你的一句话。

- 每轮把压缩后的状态注入给模型（只两行，几乎不占上下文）：

  ```text
  QUEUE: abandon, benefit, cautious
  DUE: 3 due now · 1 wrong · 52 words
  ```

- 模型严格按格式输出，不许加鼓励语、表格、总结：
  - 提问：`Q: {word}`
  - 批改：`✅ {word} = {meaning}`（会）、`🤔 {word} = {meaning}`（只记得一半）、`❌ {word} = {meaning}`（不会）
- 插件监听对话事件，解析这一行 → 记录对错 → 更新 `dueAt` → 自动发 `继续复习` 让模型问下一个词。
- 批改不是模型一个人说了算：模型给 ✅ 时，插件还会拿**上次存下的词义**和你实际打的字做比对（见下文「三档判定与二次校验」）。
- **到期词、错误次数、每日限额、下次复习时间全部由插件计算**，模型完全不参与，所以不会算错、不会"自由发挥"。

间隔阶梯（固定阶梯，类似 SM-2 的简化版）：

```text
答对：30 分钟 → 3 小时 → 12 小时 → 2 天 → 7 天 → 30 天
模糊：保持当前档位，半个间隔后重问（例如第 0 档 30 分钟 → 15 分钟后）
答错：退回第 0 档，retryDelayMinutes（默认 5 分钟）后重问
高频词：间隔 × 0.7（问得更勤）   低频词：间隔 × 1.6（问得更稀）
难度因子 ease（0.7–1.5）：答对 +0.05、模糊 −0.05、答错 −0.15
            实际间隔 = 阶梯 × 频率系数 × ease —— 熟词越问越稀，生词越问越密
```

### 三档判定与二次校验

只有"会 / 不会"两档时，「想了两秒才想起来」的词会被算成会，直接推到 3 小时甚至 2 天后，其实该更早回来。v1.4.0 起分三档，并且**插件不再完全相信模型**：

| 档位 | 什么时候用 | 怎么排期 |
| --- | --- | --- |
| `✅` 会 | 答出且词义对得上 | 升一档，按新档间隔 |
| `🤔` 模糊 | 答对了但你在犹豫（"好像…"、"不确定"）、只说了部分词义、或反问 | 档位不动，半个间隔后重问（只对上一半词义时更短：×0.35） |
| `❌` 不会 | 答错、答"不知道/忘了"、或没答 | 退回第 0 档，`retryDelayMinutes` 后重问 |

插件侧的二次校验（配置 `verifyAnswers: true`，默认开）：

- 模型给出 `✅` 时，插件用**已存词义**（`meaning` + 之前的近义说法 `meanings`）和你**实际回复的原文**做宽松比对：忽略大小写/标点、支持「放弃；抛弃」这类多义项、支持部分命中（"放弃吧" 算对）。
- 比对不上 → **按错处理**，同时把这句记进 `lastConflict`，面板上显示 `插件改判: abandon · 得到 → 放弃`。宁可多复习一遍，也不放过不会的词。
- 你直接说「不知道 / 忘了 / 不会」时，即使模型误判成 ✅，也一律算错。
- 首次出现的词没有参照词义，此时不做否决，以模型为准——避免误伤同义说法。
- 比对是**启发式**的：短中文答法（"真的" 对 "真正的；真诚的"）按字符包含判断，不会被误判；但如果你用的说法和已存释义完全对不上（确实是同义词），仍可能被判错一次；下一次模型给的释义会进 `meanings` 池，之后两种说法都算对。想完全回到「模型说了算」，把 `verifyAnswers` 设为 `false`。

### 薄弱词本与导出

面板「薄弱词」区列出所有**答错过或只记得一半**的词，按错次排序，每个词可以：

- **已掌握**：清掉错次/模糊次数，直接排到阶梯顶端（约 30 天后），并移出当前队列；
- **重问**：立刻到期，等下次开始就能问到；
- **删除**：从词库里彻底移除；
- **导出**：一键导出
  - **CSV**（`word,meaning,errors,fuzzy,stage,ease,correct,due_at,last_result_at`，带 UTF-8 BOM，Excel 直接打开不乱码）；
  - **JSON**（同样字段 + `meanings`/`source`/ISO 时间，适合自己写脚本处理）；
  - **Anki**（`word<TAB>meaning<TAB>dsh-vocab` 的 TSV，Anki 里按 Tab 分隔导入即可）。

面板还会显示**近 7 天趋势**（每天「题/错」）和一行「上次导入」摘要（导入了多少、跳过多少基础词/超纲词；如果解析出的词明显偏少会提示改用文字词表）。


### 自动续轮（v1.3.1 之后的默认行为）

一轮队列只有 `queueSize`（默认 5）个词，但这只是**批量大小，不是一节的长度**：

- `autoContinue: true`（默认开）时，队列空了会自动用**此刻已到期**的词补满并继续问，不会再"问几个就停"。
- 补队只用 `dueAt <= now` 的词，不会把还没到期的词提前拉进来烧配额；刚答过的词被推到下一档，不会被立刻重问。
- 结束只有两种可能，而且都会说明原因：
  - 到每日上限 → `loop: stopped`，面板显示 `今日已达上限 (review 12/12)`；
  - 没有到期词 → `loop: idle`，面板显示 `今天到期的单词都已复习完 · 下一个到期 17:35`，QQ 上会推一条 `✅ 今天到期的单词都复习完了（今日 N 个，下一个 17:35 到期）。想继续就回「开始背单词」。`
- 想恢复"每次只问一批"的旧行为：`autoContinue: false`。

### 每日限额

面板「限额与提醒」里可改，存进 `settings.json`，立即生效，不用重启：

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `dailyNewLimit` | `20` | 每天最多问多少个新词（0 = 不限） |
| `dailyReviewLimit` | `50` | 每天最多问多少个复习词（0 = 不限） |
| `dailyTotalLimit` | `0` | 每天总题数上限（0 = 不限） |
| `dailyMinutesLimit` | `0` | 每天复习分钟上限（0 = 不限） |

计数器 `dailyCounters: { date, new, review, total, minutes }` 存在 `ledger.json`；跨天自动清零。没有可用词时进入 `stopped` 并给出 `今日已达上限 (...)`，没问到的词留在队列里、按 `dueAt` 自然顺延。

### 到期提醒

- 每个词自带 `dueAt`；Host 定时器每 60 秒做一次**时间戳比较**（不是计数），后台节流也不会算错。
- 每天最多提醒 `reminderMaxPerDay` 次（默认 1），超过 1 次时两次之间至少间隔 3 小时。
- 提醒方式：侧栏图标红点 + 面板横幅 + 可选的浏览器通知（需已授权）。没有到期词就不会提醒。

### 侧栏面板

左侧栏图标（`sidebar.panellist`，id `vocab-review`）打开一个面板：

- 今日到期数 / 错词数 / 总词数；
- 今日计数（新词 / 复习 / 题数 / 分钟）；
- 上限提示 `今日已达上限 (…)` 与"到期了"横幅；
- 停止后说明为什么停（`idleReason`）；
- 开始 / 继续 / 停止 / 暂停；
- **薄弱词本**（答错或只记得一半的词，按错次排序；可「已掌握 / 重问 / 删除」、一键导出 CSV / JSON / Anki）、当前队列；
- 插件改判提示（`lastConflict`：模型判对但词义不符的那一次）；
- 近 7 天趋势（每天「题/错」）与「上次导入」摘要；
- 折叠的**诊断**区：词库大小、上次保存耗时、队列长度、复核与考试范围；
- 可编辑限额与提醒次数，「保存」即时写入 `settings.json`。

### 工具（给模型用）

| 工具 | 用途 |
| --- | --- |
| `vocab_import` | 导入划线单词（或文字词表），**同时可带 `extra` 里的考试高频词**；开始一轮复习，遵守限额 |
| `vocab_import_article` | 从无划线文章图片/文字里挑**考试高频词**入库：拒收 `:out` 超纲词、过滤基础词、按 `articleMaxWords` 限流、不自动开始 |
| `vocab_start` | 从保存的队列开始/继续（不重建已有队列） |
| `vocab_stop` | 停止循环；保留词表与队列，不产生对话消息 |
| `vocab_stats` | 到期/错词/队列/循环状态/计数的压缩摘要 |

### 对话选择器

面板下拉列出你已有的 DSH 对话（标题）；也可以直接在**侧栏对话的右键菜单**里点 **「设为复习对话」**（已选中的会显示「已是复习对话」），两条路径等价。选中后：

- `selectedSessionId` 写入 `settings.json`，刷新页面、重启 Host 都还在；
- 所有复习提示词（`开始词汇复习` / `继续复习`）只投给**那一个**对话，不会跑到主对话；
- QUEUE 注入与答案解析也只对那个会话的 Agent 生效。

选中的对话被归档/删除时，自动回落到第一个可用对话。若从别的对话导入词表，队列会保存并等你在选中的对话里点开始。

### QQ 通道：内置机器人（推荐）或桥接 dsh-qq-bot

#### 方式一：内置 QQ（本插件自己连，不依赖第三方插件）

适合想「装一个插件就够」的人。用的是 QQ 开放平台的官方协议，Node 自带的 `fetch` + `WebSocket`，零依赖。

1. 到 [q.qq.com](https://q.qq.com) 创建机器人，拿到 **AppID / AppSecret**；开通「私聊消息」和/或「群@消息」权限，把你自己加进沙箱成员（没上线前只有沙箱成员能聊）。
2. DSH 侧栏 **单词复习** 面板 → 展开「内置 QQ 机器人」→ 填 AppID / AppSecret（接口地址默认 `https://api.sgroup.qq.com`）→ **保存并连接**。状态会依次变成「连接中 → 已连接」，AppSecret 只存本机 `settings.json`，面板只显示是否已保存。
3. 在 QQ 里给机器人发一条消息（私聊直接发，群里 @ 它）。之后就能：
   - 用 **快捷指令面板**：在 QQ 输入 `/` 会看到 `/start`（开始背单词复习）、`/stats`（查看到期与错词）、`/stop`（停止复习，队列保留）、`/help`（查看可用命令），点一下即可；直接打中文「开始背单词 / 统计 / 停止」效果相同，插件自己处理、不消耗模型轮次；
   - **发图片**：有划线的单词表 → 导入划线词；没划线的文章 → 按考试高频词导入（这正是桥接模式做不到的）。**图片导入只入库、不自动开考**：识别结果回到 QQ 后，你再发「开始背单词」（或 `/start`）才开始出题，连发多张图也不会自动一轮轮问下去；
   - 直接回复答案 → 交给绑定会话里的模型批改 → 插件记录并推下一题；
   - 到期提醒、自动停下说明也会推到同一个 QQ 聊天。
4. 面板上的 QQ 行显示「内置 QQ 已连接」；连不上时把错误显示在面板和诊断区。

**限制与注意事项**

- 同一个 QQ 机器人 AppID **只能有一个网关连接**：内置通道和 `dsh-qq-bot` 不要同时用同一个 AppID（会互相踢下线）。要用两个就建两个机器人应用。
- 被动回复受平台限制：**同一个入站消息最多回 4 条**（每条用递增的 `msg_seq`，QQ 对重复的 `msg_seq` 会报 `40054005 消息被去重`）。插件会自动递增；超过 4 条后改走主动推送。
- AppSecret 明文保存在本机 `settings.json`（与「数据只在本机」一致，不上传）；导出/分享配置前记得清掉。
- 只做「私聊 + 群 @」的文字/图片收发：没有按钮、没有流式更新、没有多机器人/多会话绑定——这些是通用聊天机器人的能力，背单词用不上。
- 官方平台权限/审核规则可能变化；连不上时先看面板错误与 DSH 日志里的 `[qq]` 行。

#### 方式二：桥接第三方 `@hualiong/dsh-qq-bot`

如果你已经装了 `dsh-qq-bot`（见「依赖与第三方组件」），也可以让本插件走它：面板 QQ 行显示桥接状态，题目通过它的 `send_qq_message` 发，答案从它的 `[QQ] …` 入站消息里解析。注意它的**入站只支持文字**（图片消息会被它直接拒掉），所以桥接模式下图片导入请在网页对话里做，或者把文章文字贴到 QQ。

### 停止：强暂停

「停止」按钮只在当前会话正在生成时可用，执行的是和 `dsh-interrupt-button` 一样的强暂停序列：

1. `agent.cancel({ kind: 'user' }, { keepInbox: true })`
2. 杀掉该 Agent 的后台 jobs
3. 杀掉它的 terminals
4. 中断它的子代理
5. 如有武装的 goal，则解除

全程静默：不写提示词、不 steer、不伪造对话消息。之后循环仍是 `running`、队列原样保留，点继续即可接着问。只影响**被选中的**那个会话。

### 配置

插件配置写在 `cordis.patch.yml` 的 `vocab-review` 行里；每日限额与提醒次数也可以在面板里改（存 `settings.json`，优先于默认值）。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `queueSize` | `5` | 一轮队列词数（1–20），只是批量大小 |
| `autoContinue` | `true` | 队列空了自动用已到期词续轮 |
| `wrongInject` | `2` | 每轮随机插入的错词数 |
| `retryDelayMinutes` | `5` | 答错后多久重问 |
| `verifyAnswers` | `true` | 插件用已存词义二次校验模型的 ✅，不符按错处理 |
| `articleMaxWords` | `20` | 一次文章导入最多新增多少个词（1–100）；划线图的 `extra` 高频词也用它限量 |
| `includeHighFreq` | `true` | 划线图里没划线的考试高频词也一起入库；`false` = 只收划线词 |
| `examLevel` | `cet4` | 文章导入的目标考试：`gaokao` / `cet4` / `cet6` / `kaoyan` / `any` |
| `ladderMinutes` | `[30,180,720,2880,10080,43200]` | 间隔阶梯（分钟） |
| `highMultiplier` / `lowMultiplier` | `0.7` / `1.6` | 高频词更勤 / 低频词更稀 |
| `maxRecentErrors` | `5` | 面板最近错词条数 |
| `startPrompt` / `continuePrompt` | `开始词汇复习` / `继续复习` | 注入的提示词 |
| `dataDir` | `<DSH_HOME>/vocab-review` | 数据目录 |
| `channel` | `auto` | `auto` / `qq` / `session` |
| `qqStatePath` | `<DSH_HOME>/integrations/dsh-qq-bot/state.json` | 桥接模式读取的机器人状态文件 |
| `qqApiBase` | `https://api.sgroup.qq.com` | 内置 QQ 的接口地址（一般不用改，面板里也能填） |

### 性能与可观测性

- **实测**（`test/harness.mjs` 的性能检查）：1500 词的词库，Host 加载约 13ms，一次保存约 3.6ms。所以不拆片、不引入 SQLite 也不会成为瓶颈；`ledger.json` 的写盘本来就是**临时文件 + rename 的原子写**，写到一半断电也不会把词库写坏。
- **结构化日志**：每次批改打一行 `[grade] word=abandon verdict=fuzzy factor=0.35`；每次导入打一行 `[import] mode=article parsed=10 added=5 basic=3 out=1 capped=1`；保存超过 40ms 会打 `slow ledger save` 警告。反馈问题时贴这几行就能定位。
- **面板「诊断」区**（折叠）：词库条数与文件大小、上次保存耗时、队列长度、插件复核开关、文章考试范围。

### 隐私与安全

- **不联网、不上报、不需要任何密钥**（除你主动启用的内置 QQ：它需要 QQ 开放平台的 AppID/AppSecret 才能连网关）。全部逻辑跑在本机 Host。
- **AppSecret 只存在本机 `settings.json`**（明文，面板只显示「已保存」；状态接口永远不返回 secret）。
- **单词表图片不会被插件读取或保存**：读图由聊天模型完成，只把纯文本词表交给插件。
- 插件只写两个文件：`<DSH_HOME>/vocab-review/ledger.json`（词表/队列/计数）与 `settings.json`（限额、所选对话、提醒记录），原子写入（临时文件 + rename）。
- 强暂停只碰**被选中**会话的 Agent / jobs / terminals / 子代理，不动别的会话。
- QQ 通道只读机器人的 `state.json`（绑定会话 + 最近聊天目标），复用它已有的 `send_qq_message` 发送；不读 AppID/AppSecret，也不另开一条 QQ 连接。

### 测试

```powershell
npm test          # 4 个离线 harness
npm run check     # 语法检查
```

- `test/harness.mjs` —— 31 项：导入、✅/❌/🤔 记账、压缩注入、停止/继续、每日限额、面板改限额、每日提醒、跨天清零、重启持久化、QQ 通道、**自动续轮**、QQ 自动停下时推一条说明、**插件否决模型 ✅**、**模糊半档**、**🤔 后正常 ✅ 升档**、**薄弱词本 + 已掌握/重问/删除 + CSV 导出**、**ledger 版本守卫**、**「不知道」一律算错**、**短中文近义半会并记入词义池**、**文章导入（过滤基础词 + 拒收 `:out` 超纲词 + 限流 + 不自动开始）**、**文章导入边界（全是基础词 / 已有词）**、**考试范围（单次指定考试、`:out` 拒收、`examLevel` 默认值）**、**难度因子 ease**、**CSV/JSON/Anki 三种导出**、**每日历史**、**诊断字段与上次导入**、**1500 词性能**、**划线图附带 `extra` 高频词（过滤 + 限量 + 来源标记）**、**`includeHighFreq:false` 只收划线词**。
- `test/qq-builtin.mjs` —— 内置 QQ 的离线联调（假网关 + 假 HTTP）：token→gateway→identify、心跳、入境文字→会话提示→回传、入境图片→图片块、命令「开始背单词」直接推题、答题批改后推下一题、消息去重、断线/禁用状态。
- `test/sessions-stop.mjs` —— 对话列表/选择持久化/路由、强暂停、归档回落。
- `test/client-load-check.mjs` —— 用 mock loader 跑一遍 Client 半边，确认侧栏与面板注册。
- `test/make_test_image.py` —— 重新生成 3 个划线词的测试图片。

### 限制

- 取词依赖聊天模型的读图能力，插件本身不做 OCR。
- 复习在对话里进行；没有会话时「开始」会提示你先开一个。
- `继续复习` 是一条可见的 user 消息，这是故意的——它是模型下一次回答的唤醒信号。
- 浏览器通知需要你点过授权；侧栏红点与面板横幅不需要。
- 二次校验是启发式的：同义但字面完全不同的答法可能被判错一次，`verifyAnswers: false` 可关掉。
- 文章里的**考试高频词由模型按考纲词频挑选**；插件负责拒收 `:out` 超纲词、过滤内置基础词、去重和数量上限。若某个词你觉得该收却被过滤，直接发文字词表补进词库。图片太糊时它会挑不出词，给更清晰的图或贴文字最稳。

---

# English docs

Underlined-word vocabulary review for DeepSeek Harness. This README is bilingual: 中文在上，English below.

## Install

Requires DeepSeek Harness 0.2.x and Node 22+. **This plugin itself has no npm runtime dependencies.** The optional QQ channel has two transports: the **built-in QQ bot** (enter your QQ 开放平台 AppID/AppSecret in the panel; this plugin connects itself, no third-party plugin) or a **bridge** to `@hualiong/dsh-qq-bot` if you already have it installed.

**From GitHub:**

```powershell
dsh plugin --profile <profile> add github:at3623/dsh-vocab-review
```

**Local directory**: DSH → **Plugins** → **Add plugin** → select this directory, or call the Plugin Manager's `install_bundle` with the absolute path.

The bundle patch inserts the `vocab-review` row; the Client half is discovered from `dsh.client` and `./client`. After a client-side update, refresh the GUI page once (or restart DSH).

## Dependencies & third-party components

**This plugin has no npm runtime dependencies.** Image reading/import, the word schedule, three-tier grading and verdict verification, the ease factor, daily quota, due reminders, the sidebar panel, the ledger, the CSV/JSON/Anki exports, and the **built-in QQ bot** (QQ 开放平台 auth, WebSocket gateway, messages, image download — using Node's own `fetch`/`WebSocket`) are all implemented in this repository (`index.js` + `client.js` + `qq/` + `locale/` + `icon.svg`).

The third-party `@hualiong/dsh-qq-bot` plugin is only an **alternative transport** when you already run it. Pick one: the built-in client and the bot must not use the same AppID (one QQ bot can only hold one gateway connection).

| Component | Source | How this plugin uses it | Boundary |
| --- | --- | --- | --- |
| **Built-in QQ** (shipped here) | `qq/client.js` + `qq/bridge.js` in this repo, zero dependencies | Connects to QQ 开放平台 itself: token from `bots.qq.com`, WebSocket from `api.sgroup.qq.com/gateway`, receives `C2C_MESSAGE_CREATE` / `GROUP_AT_MESSAGE_CREATE`, sends text and images to the selected DSH session, replies passively or as a push | Needs your own bot AppID/AppSecret; the secret is stored in plain text in the local `settings.json`; one bot app = one gateway connection |
| `@hualiong/dsh-qq-bot` (0.4.x, MIT) | Third-party community plugin by hualiong, [GitHub](https://github.com/hualiong/dsh-qq-bot) | Used only as a fallback when the built-in client is not configured: reads its state file `<DSH_HOME>/integrations/dsh-qq-bot/state.json` (`sessionId`, `target`, `ownerOpenId`) and calls its `send_qq_message({ text })` tool | Inbound is text-only there; its code is not copied or bundled; its AppSecret is not read |

- The built-in client talks only to the documented QQ Open Platform endpoints; no SDK and no extra package.
- This plugin's `package.json` declares no dependency on `dsh-qq-bot` and ships none of its code. `dsh-qq-bot` itself depends on Tencent's `@tencent-connect/qqbot-*` and `qrcode`; those belong to it. The bridge mode is verified against 0.4.2 (state-file shape + `send_qq_message`).
- One QQ bot app can only hold one gateway connection: do not run the built-in client and `dsh-qq-bot` on the same AppID; create a second bot app if you want both.

## Security & privacy

- **No telemetry.** Everything runs on the local Host. The only outbound traffic is the QQ Open Platform connection when you enable the built-in bot (or the bot plugin's own traffic in bridge mode).
- The **built-in QQ AppSecret** is stored in plain text in the local `settings.json`; the state API only reports whether it is set, never the value.
- The worksheet image is **never read or stored by the plugin**; the chat model extracts the underlined words and calls `vocab_import` with plain text. (A QQ image is downloaded to memory, passed as a prompt image block, and discarded.)
- The plugin writes only two files under `<DSH_HOME>/vocab-review/`: `ledger.json` (words/queue/counters/QQ target) and `settings.json` (limits, selected conversation, reminder bookkeeping, optional QQ credentials).
- The strong-pause Stop only touches the **selected** session: its Agent, its background jobs/terminals, and its child subagents — never other sessions.
- In bridge mode the QQ channel only reads `<DSH_HOME>/integrations/dsh-qq-bot/state.json` (bound session id + last chat target) and delivers through the bot's own `send_qq_message` tool; it never reads that bot's credentials.

## What it does

1. **Image ingestion (the headline feature)** — the user uploads a worksheet image. The model reads it, extracts every **underlined English word** in base form, and calls `vocab_import` with a comma-separated list. **Exam high-frequency words that appear in the same image without an underline are added too**: the model passes them in the same call's `extra` field, and the plugin filters basic words, refuses `:out` words, deduplicates and caps them at `articleMaxWords` (source `exam`); set `includeHighFreq: false` to import underlined words only. The plugin normalizes the list, deduplicates it, and stores only the words; the image is never read or kept by the plugin. A typed word list works exactly the same way. A **plain article image with no underlines** takes the `vocab_import_article` path described below: the model keeps only the **exam high-frequency** words, `:out`/basic words are refused, the batch is capped, and the loop waits for the user.
2. **Q&A loop driven by the plugin** — each turn injects a compact queue:

   ```text
   QUEUE: abandon, benefit, cautious
   DUE: 3 due now · 1 wrong · 52 words
   ```

   The model asks exactly one word (`Q: {word}`). After the answer it emits exactly one line, `✅ {word} = {meaning}` (known), `🤔 {word} = {meaning}` (half-known) or `❌ {word} = {meaning}` (unknown). The plugin watches the committed session event, records the result, and wakes the same chat with `继续复习` for the next word. The model never computes due words, quota, or scheduling — and it does not get the final say on correctness either: a model `✅` is re-checked against the stored meaning (see below).
3. **Wrong-word ledger** — every error increments `errors` and stamps `lastErrorAt` in `<DSH_HOME>/vocab-review/ledger.json`; a fuzzy answer increments `fuzzy` instead. A correct answer advances the spaced-repetition stage and schedules the next review; the error history stays.
4. **Spaced repetition** — ladder `30m → 3h → 12h → 2d → 7d → 30d`, modulated by a per-word **ease factor** (0.7–1.5; +0.05 per correct answer, −0.05 fuzzy, −0.15 wrong): a word you keep getting right drifts out, a shaky word tightens up. A wrong answer resets the word to stage 0 and re-queues it after `retryDelayMinutes`. The queue builder pulls due reviews first, then due new words, injects a configurable number of previously-wrong words at random, then fills the rest with higher-frequency words (high-frequency weighted up, low-frequency down).
5. **Persistence** — `ledger.json` (words, queue, loop state, daily counters) and `settings.json` (limits + reminder bookkeeping) are written atomically (temp file + rename). Page reloads never touch Host state; a Host restart reloads the queue and keeps the loop **stopped** until Start is pressed.

## Article images (exam high-frequency words)

A worksheet has underlines, so every word is wanted. A normal article, reading comprehension text or news screenshot has none, and dumping every word into the ledger would bury it in trivia. The selection criterion here is **exam frequency — not how often a word repeats in the article**: the words worth adding are the ones that keep turning up in real 高考 / CET-4 / CET-6 / 考研 papers. That path is `vocab_import_article`:

1. Upload the article image (or paste the article text).
2. The model reads it and keeps the words that are high-frequency **for the target exam** (default CET-4, set by `examLevel`; if the user asks for 考研/四级/六级/高考 the model passes `exam`). It tags core high-frequency items `:high` (shorter interval), tags out-of-scope or rare words `:out`, and calls `vocab_import_article`.
3. The plugin filters that list:
   - **refuses `:out` words** — anything the model marked as out of scope or rare never enters the ledger;
   - **drops basic everyday words** — anything in the built-in basic-word list (`the / is / have / good / school`…) is never added;
   - **deduplicates and normalizes** the forms the model returned;
   - **caps the batch** at `articleMaxWords` (default 20) and reports the words that did not fit.
4. **It does not start the loop.** The tool result names the scope (e.g. CET-4), the added words, the filtered basic words, the refused out-of-scope words and anything over the cap; the model tells the user in one or two lines, and the review starts only when the user presses Start or says 「开始背单词」.

```text
You:   [upload a plain article image, no underlines]
Model: reads it, keeps the exam high-frequency words → vocab_import_article("abandon:cet4, benefit:high, quixotic:out, ...")
Plugin: refuse :out + drop basic words (the/is/school) + dedupe + cap 20 → ledger.json
Model: picked 12 CET-4 high-frequency words: abandon, benefit, cautious … (abandon is a core high-frequency item)
You:   开始背单词
Plugin: Q: abandon …
```

The division of labour: **underlined worksheet = the user chose, the plugin takes all**; **article = the model picks by exam-frequency, the plugin refuses out-of-scope and basic words, and the user confirms**. Raise `articleMaxWords` to take more per article; change `examLevel` (or say the exam in the request) to target a different syllabus; a basic word you still want can be added through a typed word list (`vocab_import`).

## Loop-level Stop / Start (req. 9)

- The panel **Stop** button sets the loop from `running` to `stopped`. The plugin simply does **not issue the next question**. It never calls `agent.cancel` and never injects a "stopped" message, so the transcript stays clean. If a model reply is in flight, it finishes and is recorded; then the loop stops.
- Answered words are already persisted and the queue is kept. **Start** resumes from the queue head without recounting the question that was already counted.
- Loop states: `idle` (nothing left to ask — see `idleReason`), `running`, `stopped`.

## Continuous review (auto-continue)

A queue holds `queueSize` words (default 5) — that is a **batch size, not a session length**. With `autoContinue` on (the default), the loop refills itself from words that are due **now** and keeps asking, so it no longer goes quiet after a handful of words.

- Refill only takes words whose `dueAt <= now`, so auto-continue never asks a word far ahead of its schedule. A word that was just answered is pushed forward (`ladder`, or `retryDelayMinutes` after an error) and therefore is not re-picked immediately.
- The loop now ends in exactly two ways: the daily limit is hit (`loop: "stopped"` plus `今日已达上限 (…)`), or nothing is due any more (`loop: "idle"` plus `idleReason`).
- When it stops by itself it says why instead of going silent: the panel shows `今天到期的单词都已复习完 · 下一个到期 17:35`, and in QQ mode the plugin pushes one short line — `✅ 今天到期的单词都复习完了（今日 N 个，下一个 17:35 到期）。想继续就回「开始背单词」。`
- `autoContinue: false` in the plugin config restores the old "one batch per Start" behaviour; `queueSize` (1–20) tunes the batch.

## Three-tier grading and plugin-side verification (v1.4.0)

Two tiers force "recognised after a pause" into "known", which pushes the word 3 hours or two days out when it should come back sooner. Since v1.4.0 there are three grades, and the plugin no longer trusts the model blindly:

| Grade | When | Scheduling |
| --- | --- | --- |
| `✅` known | Answer matches the meaning | Advance one stage, next review at the new interval |
| `🤔` half-known | Right, but the user hedged (`好像…`, `不确定`), gave only part of the meaning, or asked back | Stage unchanged, comes back after **half** the current interval at most (×0.35 when only half the gloss matched) |
| `❌` unknown | Wrong, "不知道/忘了", or no answer | Reset to stage 0, re-ask after `retryDelayMinutes` |

Plugin-side verification (`verifyAnswers: true`, the default):

- On a model `✅`, the plugin compares what the user actually typed with the stored gloss (`meaning` plus earlier alternatives in `meanings`): case and punctuation ignored, multi-gloss entries (`放弃；抛弃`) accepted, partial answers ("放弃吧") accepted.
- No match ⇒ **recorded as wrong**, and the disagreement is kept as `lastConflict`, shown in the panel as `插件改判: abandon · 得到 → 放弃`. Better to review a word once too often than to let a wrong meaning pass.
- An explicit "不知道 / 忘了 / 不会" is always wrong, even if the model says `✅`.
- A word seen for the first time has no reference gloss yet, so the model's first grading stands — this avoids punishing synonyms.
- The comparison is a **heuristic**: a short Chinese rewording of the stored gloss ("真的" for "真正的；真诚的") is accepted by character containment, so it is not punished; a synonym that shares nothing with the stored gloss is still counted wrong once, and the model's next gloss joins `meanings`, after which both wordings pass. Set `verifyAnswers: false` to go back to trusting the model alone.

## Weak-word book and CSV export

The panel lists every word with `errors > 0` or `fuzzy > 0`, hardest first, with three actions:

- **Known** — clear error/fuzzy counts, move it to the top of the ladder (~30 days out) and drop it from the current queue;
- **Ask again** — due immediately;
- **Remove** — delete it from the ledger;
- **Export CSV** — `word,meaning,errors,fuzzy,stage,ease,correct,due_at,last_result_at` with a UTF-8 BOM, ready for Excel or 欧路.
- **Export JSON** — the same fields plus `meanings`/`source` and ISO timestamps, for scripts.
- **Export Anki** — `word<TAB>meaning<TAB>dsh-vocab` TSV, imported by Anki with a tab separator.

The panel also shows a **last-7-days trend** (asked/wrong per day) and a one-line **last import** summary (how many words were added, how many basic/out-of-scope words were dropped — with a hint to paste the text when the image probably lost words).

## Daily quota (req. 11)

`settings.json` / the panel's **Limits & reminder** section control:

| Key | Default | Meaning |
| --- | --- | --- |
| `dailyNewLimit` | `20` | New words asked per day (0 = unlimited). |
| `dailyReviewLimit` | `50` | Previously-answered words asked per day (0 = unlimited). |
| `dailyTotalLimit` | `0` | Total questions per day (0 = unlimited). |
| `dailyMinutesLimit` | `0` | Active review minutes per day (0 = unlimited). |

`dailyCounters: { date, new, review, total, minutes }` lives in `ledger.json`. Every quota check calls `ensureDay()`: a new local date resets all four counters to zero. Before each question the plugin picks the first eligible word (due reviews before new words); when no word is eligible it sets `stopped` and shows `今日已达上限 (<kind> <used>/<limit>)`. Unprocessed words stay in the queue / defer naturally through `dueAt`.

## Due reminder (req. 10)

- Every word already carries a `dueAt` timestamp. A Host `ctx.timer` tick (60 s) compares `now >= min(dueAt)` — a timestamp comparison, not a tick count, so background throttling cannot skew it.
- `settings.json` stores `lastRemindedDate`, `remindCountDate`, `remindCount`, `lastRemindAt`, plus `reminderMaxPerDay` (default 1). At most that many reminders per day; a 3-hour minimum gap applies when the cap is above 1.
- Trigger delivery: a badge dot on the sidebar icon (plus the panel banner) and an optional browser `Notification` (only when permission is already granted). The collapsed-sidebar `sidebar.toggle.badge` slot is a single-occupant shell slot, so it is deliberately not registered — a rejected registration there used to blank the whole client entry.
- No words / nothing due ⇒ no reminder.

DSH reuse note: the shipped `schedule` service delivers **prompts into a Session**, which would create transcript rows; it is not used. The reusable parts are the Host `ctx.timer`, the `sidebar.toggle.badge` / `sidebar.panellist` slots, and the browser Notification API.

## Sidebar

The plugin registers a left-sidebar icon (`sidebar.panellist`, id `vocab-review`) and a root-scoped `main` panel keyed `vocab-review`:

- today's due count, wrong count, total words;
- today's counters (new / review / questions / minutes);
- the quota stop message `今日已达上限 (…)`;
- an idle reason line after an automatic stop;
- a due-reminder banner;
- Start / Resume / Stop;
- the **weak-word book** (failed or half-known words, hardest first, with Known / Ask again / Remove and CSV / JSON / Anki export);
- the last-7-days trend and the last-import summary;
- a collapsed **Diagnostics** block (ledger size, last save duration, queue length, verify flag, article exam scope);
- the current queue;
- a plugin-veto line (`lastConflict`) when the plugin overruled a model `✅`;
- editable limits + reminder cap with **Save** — applied in memory and written to `settings.json` immediately, no restart.

## Tools

| Tool | Purpose |
| --- | --- |
| `vocab_import` | Import underlined words (or a typed list) plus optional exam high-frequency `extra` words from the same image, start a session, respect quota. |
| `vocab_import_article` | Pick the **exam high-frequency** words from a plain article image/text: refuse `:out` words, filter basic words, cap at `articleMaxWords`, never auto-start. |
| `vocab_start` | Start/Resume from the saved queue (does not rebuild a kept queue). |
| `vocab_stop` | Stop the loop; keeps ledger + queue, no transcript message. |
| `vocab_stats` | Compact due/wrong/queue/loop/counter summary. |

## Conversation selector (req. 7)

The panel has a dropdown listing the user's existing DSH conversations (title only); the sidebar session **context menu** also offers **Use for vocabulary review** (“Vocabulary review conversation” when it already is), with the same effect. The Host builds the list from `sessionController.list()` and reads each row's `projections.values.title`, filters `origin: 'subagent'` / `parentSessionId` rows, and drops every id in `workspaceRegistry.archivedSessionIds`. Selecting a conversation:

- writes `selectedSessionId` to `settings.json` (survives page reload and Host restart);
- routes every vocabulary prompt (`开始词汇复习`, `继续复习`) through `sessionController.prompt({ sessionId })` to that conversation — never to the main conversation;
- limits the QUEUE/protocol prompt injection and the answer-line parser to that session's Agent.

If the selected conversation is archived or deleted, the panel falls back to the first live conversation. Importing words from a different conversation stores the queue and waits for Start in the selected one (the import result says so).

## QQ channel: built-in bot (recommended) or dsh-qq-bot bridge

## QQ channel: built-in bot (recommended) or dsh-qq-bot bridge

### Built-in QQ bot (self-hosted, no third-party plugin)

The built-in client uses the official QQ Open Platform protocol with Node's own `fetch` and `WebSocket` — no SDK, no npm package:

1. Create a bot at [q.qq.com](https://q.qq.com), copy its **AppID / AppSecret**, enable the 私聊消息 and/or 群@消息 permissions, and add yourself to the sandbox members (only sandbox members can chat before release).
2. In the DSH sidebar **Vocabulary review** panel, open **Built-in QQ bot**, enter AppID / AppSecret (API base defaults to `https://api.sgroup.qq.com`) and press **Save & connect**. The status becomes “connecting → connected”. The secret is stored only in the local `settings.json`; the panel never shows it again.
3. Send the bot one message in QQ (private chat directly, or @ it in a group). Then you can:
   - use the **slash-command panel**: typing `/` in QQ shows `/start` (start the review), `/stats` (due + wrong counts), `/stop` (stop, keep the queue) and `/help`; tapping an entry fills the box. Typing 开始背单词 / 统计 / 停止 works the same, and the plugin handles these without a model turn;
   - **send an image**: an underlined word list imports its underlined words; a plain article imports its exam-high-frequency words — the thing the bridge cannot do. **An image import only fills the ledger and never auto-starts the review**: after the summary comes back to QQ, send 「开始背单词」 (or `/start`) to begin asking questions, so importing several images in a row cannot start a runaway loop;
   - reply with an answer → the model in the selected session grades it → the plugin records it and pushes the next question;
   - due reminders and automatic-stop notes arrive in the same QQ chat.

Limits: one QQ bot app can hold only one gateway connection (do not run the built-in client and `dsh-qq-bot` on the same AppID); passive replies are limited to **4 per inbound message** and every reply needs an increasing `msg_seq` (QQ rejects duplicates with `40054005`), which the client handles automatically before falling back to an active push; the AppSecret is plain text in the local `settings.json`; only C2C + group @ text/images (no buttons, no streaming, no multi-chat bindings); if the platform changes permissions or the connection fails, the panel error and the `[qq]` log lines show why.

### Bridge to `@hualiong/dsh-qq-bot`

If you already run that bot (see “Dependencies & third-party components”), the plugin can use it instead: the panel QQ row shows the bridge state, questions go out through its `send_qq_message` tool, and answers come back from its `[QQ] …` inbound messages. Its **inbound is text-only** (image messages are rejected there), so import images from the Web chat or paste the article text into QQ.

## Stop (strong pause, req. 8)

The Stop button sits next to Start/Resume and is enabled only while `turnInFlight` is true (the selected session's Agent has `status === 'running'`, polled every 2 s). It calls the same strong-pause sequence as `dsh-interrupt-button`:

1. `agent.cancel({ kind: 'user' }, { keepInbox: true })`
2. `jobs.list(agent.id)` → `jobs.kill(id, caller, reason)` for running jobs
3. `terminals.list(agent)` → `terminals.kill(agent, id, reason)`
4. `subagents.listDescendants(sessionId)` → `subagents.interrupt(childId, { kind: 'ancestor', agent })`
5. optional `goals.disarm(agent)` when an armed goal exists

It is silent: no prompt, no `steer`, no fake transcript message. Afterwards the Host returns `turnInFlight: false` and the loop stays `running` with its queue intact, so Continue/Start can issue the next question. The old loop-level pause remains as the small **Pause loop** action.

## Performance & observability

- **Measured** (the performance check inside `test/harness.mjs`): a 1500-word ledger loads in ~13 ms and saves in ~3.6 ms. Sharding or SQLite would add complexity without solving anything at this scale, and `ledger.json` is already written atomically (temp file + rename), so an interrupted write cannot truncate it.
- **Structured logs**: one line per grade (`[grade] word=abandon verdict=fuzzy factor=0.35`), one per import (`[import] mode=article parsed=10 added=5 basic=3 out=1 capped=1`), and a `slow ledger save` warning above 40 ms. Those lines are enough to diagnose a report.
- **Diagnostics** in the panel: ledger size, last save duration, queue length, verify flag, article exam scope.

## Verification

- `npm test` — runs the three offline harnesses below.
- `node test/harness.mjs` — Host harness: 3-word import, ✅/❌ ledger updates, compact injection, loop Pause (no prompt, queue kept), Start resume without double-counting, `dailyTotalLimit=5`, live settings edits, once-per-day reminder, date rollover, reload persistence, the QQ channel (binding discovery, Start pushes `Q:` through `send_qq_message` without prompting the web session, QQ-graded answer recorded, next question pushed only after that turn ends), continuous review (with `queueSize: 2` the loop still asks all 5 due words, then goes `idle` with a `no-due` reason), the QQ idle note, **the plugin veto (a model `✅` with a different meaning is scheduled as wrong)**, **the fuzzy half-step**, **a fuzzy followed by a matching ✅ advancing the ladder**, **the weak-word book plus Known/Ask again/Remove and the CSV export**, **the ledger schema guard**, **"不知道" being wrong even when the model says `✅`**, **a half-matched rewording graded half-known and joining the gloss pool**, **the article import (basic words filtered, `:out` refused, batch capped, loop waiting for Start, protocol updated)**, **the article edge cases (all-basic list, already-known words)**, **the exam scope (per-call exam level, `:out` refusal, `examLevel` as the default)**, **the ease factor**, **CSV/JSON/Anki exports**, **the daily history**, **diagnostics + last import**, **the 1500-word performance check**, **exam high-frequency `extra` words on a worksheet import (filtered, capped, source `exam`)**, and **`includeHighFreq: false` importing underlined words only**.
- `node test/qq-builtin.mjs` — offline built-in QQ test with a fake gateway and fake HTTP: token → gateway → identify, heartbeat, inbound text → session prompt → relay, inbound image → image prompt block, 开始背单词 pushing `Q:` directly, grading round trip + next question, message deduplication, disconnect/disable status.
- `node test/sessions-stop.mjs` — conversation list (titles, archived/subagent excluded), selection persisted in `settings.json` + reload, Start routed to the selected session, strong-pause Stop (cancel + jobs/terminals/subagents, silent, `turnInFlight` false), idle Stop no-op, archived-selection fallback.
- `node test/client-load-check.mjs` — evaluates the Client bundle with a mocked module loader and asserts the sidebar/main registrations.
- `test/make_test_image.py` — regenerates the 3-underlined-word fixture (`pip install pillow`).
- `node test/restart-check.mjs` (not in CI) — loads the profile-installed package with the real ledger/settings; requires a local DSH profile.

## Limits

- Word extraction relies on the chat model's image reading; the plugin does not run OCR.
- Review runs inside a chat session; with no session, Start asks you to open one.
- The continuation prompt (`继续复习`) is a visible user-role message by design — it is the wake-up for the next question.
- Browser notifications require the user to grant permission; the sidebar badge and panel banner always work without it.
- The plugin-side verification is a heuristic: a synonym that shares nothing with the stored gloss may be counted wrong once; `verifyAnswers: false` disables it.
- The built-in QQ bot needs your own QQ 开放平台 AppID/AppSecret and the matching permissions; one bot app supports one gateway connection (built-in and `dsh-qq-bot` cannot share an AppID). The AppSecret is plain text in the local `settings.json`.
- The exam high-frequency words are **chosen by the model against the syllabus frequency**; the plugin refuses `:out` words, filters its basic-word list, deduplicates and caps the batch. If a word you wanted got filtered, add it through a typed word list. A blurry image yields few words — a clearer photo or the pasted text works better.
