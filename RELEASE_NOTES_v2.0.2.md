# v2.0.2 — 右键菜单里也能「设为复习对话」

以前只能在侧栏面板的下拉框里选「复习对话」。现在在**侧栏对话的右键菜单**里多了一项：

- **设为复习对话** → 把这个对话设为单词复习的目标会话（等价于面板下拉选择，写入 `settings.json` 的 `selectedSessionId`，刷新/重启都保留）；
- 当前已经选中的对话会显示 **已是复习对话**，再点一次无副作用。

位置在「绑定 QQ 会话」（`dsh-qq-bot` 的 890 号）上方，内部登记为 `sidebar.workspaces.session.menu.item` 的 `vocab-review-review-target`（order 889）。

## 实现

- Client 半边新增一个会话右键菜单项，点击调用现成的 `POST /api/dsh-vocab-review/select`，与面板下拉走同一条路径；
- 菜单项通过 `@deepseek-ai/dsh-client-ui-primitives` 的 `MenuItemButton` 渲染，风格与自带菜单项一致；拿不到 primitives 时只跳过这一项，**不会影响面板与侧栏图标**；
- 标签随当前选中状态切换（「设为复习对话」/「已是复习对话」），本地化中英文；
- `test/client-load-check.mjs` 增加了菜单项注册断言（仍需正常注册侧栏与主面板）。

## 升级

- 版本 2.0.1 → **2.0.2**，`npm test` 全绿。
- 这是 Client 改动：更新后**刷新一次网页**，右键任意对话即可看到新菜单项。
