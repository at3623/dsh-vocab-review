# v2.0.4 — QQ 快捷指令面板（/start /stats /stop /help）

之前说的「QQ 命令」只能靠打中文短语。这一版把内置 QQ 机器人注册成 **QQ 快捷指令面板**：在 QQ 输入框里打 `/`，就能像 `/bind`、`/status` 那样直接看到并点击我们的命令。

## 面板里的命令

| 指令 | 作用 |
| --- | --- |
| `/start` | 开始/继续背单词复习（等价于「开始背单词」，插件直接推第一题，不消耗模型轮次） |
| `/stats` | 到期数、错词数、模糊数、总词数、下一个到期时间、今日题数 |
| `/stop` | 停止复习，队列保留 |
| `/help` | 列出可用命令 |

- 中文短语仍然有效：「开始背单词 / 统计 / 停止」；
- 面板在机器人每次连上网关（READY）时自动创建/更新：已经存在就原地更新，不会重复新增；
- 平台限制：一个面板最多 5 个条目，CJK 字符按 2 个字符计数——当前 4 条在限制内；
- 没有面板权限的机器人账号会跳过这一步（记一条 `[qq] command panel skipped` 日志），命令照样能打。

## 实现

- `qq/client.js`：READY 时调用 `publishPanel()` → `GET /v2/panels?scope=c2c&limit=50`，按 `remark: "dsh-vocab-review"` 找到自己的面板就 `PUT /v2/panels/{id}`，否则 `POST /v2/panels`；失败不影响连接与收发；
- `index.js`：命令解析支持前导 `/`（`/start`、`/stats`、`/stop`、`/help`），并新增 `/help` 回复；
- 测试：READY 后创建面板、再次 READY 原地更新不重复；`/stop`→`/stats`→`/help`→`/start` 全链路验证。

## 关于旧面板

如果你之前用过 `dsh-qq-bot`，它的指令面板（`/bind`、`/model` 那套）仍然留在 QQ 平台侧，可能出现两套快捷指令。停用 `dsh-qq-bot` 后可以在 [q.qq.com](https://q.qq.com) 的机器人后台或 QQ 客户端的指令管理里删掉旧面板；本插件不会去删别的插件的面板。

## 升级

- 版本 2.0.3 → **2.0.4**，`npm test` 全绿。
- Host 改动：刷新网页或在插件管理里禁用→启用 `dsh-vocab-review`；重连后打开 QQ 输入 `/` 即可看到新面板。
