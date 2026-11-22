# v2.1.0 — 划线图里没划线的考试高频词也一起收

以前划线图只收**划线词**。但一张试卷/阅读图里往往还有不少没划线的考试高频词（四六级/考研考点词），它们同样值得背。现在：

## 新行为

- 模型读划线图时，除了划线词，还会把**同一张图里出现的考试高频词**放进同一次 `vocab_import` 调用的 `extra` 字段；
- 插件对 `extra` 做和文章导入一样的处理：
  - 过滤内置基础词（`the / is / good`…）；
  - 拒收模型标 `:out` 的超纲/生僻词；
  - 和划线词去重；
  - 按 `articleMaxWords`（默认 20）限量；
  - 词条来源记为 `exam`（导出 JSON 里能看到 `source: "exam"`）。
- 队列顺序：**先划线词，再高频 extras**；
- 面板「上次导入」会显示 `+N 高频词`；
- 工具返回会写 `Also added N exam high-frequency word(s)…`，模型据此告诉你收了多少；
- 不想要这个行为：配置 `includeHighFreq: false`，回到「只收划线词」。

## 配置

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `includeHighFreq` | `true` | 划线图里没划线的考试高频词也一起入库 |
| `articleMaxWords` | `20` | 一次导入最多新增词数；`extra` 高频词也用它限量 |

## 实现

- `importWords` 新增 `extras` 解析：独立解析、独立过滤/去重/限量，写入 `source: "exam"`，并追加到队列尾部；
- `vocab_import` 工具新增可选参数 `extra`（描述里明确「只收图里真实出现的词，不要编造」）；
- 注入给模型的协议同步更新（划线图要求把未划线的考试高频词放进 `extra`）；
- `lastImport` 与工具返回都带上 extras 数量；
- 测试 29 → **31 项**：`extra` 过滤/去重/限量/来源标记、`includeHighFreq:false` 只收划线词。

## 升级

- 版本 2.0.4 → **2.1.0**，`npm test` 全绿。
- Host + Client 都有改动：刷新网页；或在插件管理里禁用→启用 `dsh-vocab-review`。
- 旧 `ledger.json` 兼容（新增的可选 `source: "exam"` 缺失时按 `list` 处理）。
