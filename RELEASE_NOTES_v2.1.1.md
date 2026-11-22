# v2.1.1 — 修复 HTTP 路由缺少 DSH 访问检查（安全）

## 问题

awesome-dsh-plugin 的维护者在合并收录 PR（#17853）时指出：本插件的 HTTP 路由（`/api/dsh-vocab-review/*`）挂在 DSH 的 WebServer 上，但没有经过 **DSH 的 connection 信任检查**（`ctx.connection.requestRejection`）。原来的 `trusted()` 只看 `Origin`/`Host`，对**没有 Origin 头的请求直接放行**，所以浏览器里打开的任意网页理论上可以跨站调用这些接口（例如触发 `stop`/`interrupt`、读取状态或导出数据）——CSRF 风险。

## 修复

所有 HTTP 请求进入路由后第一步：

```js
const connection = ctx.get('connection')
const rejection = connection?.requestRejection?.(req)
if (rejection !== undefined) return 拒绝(rejection) // 401 / 403
```

`requestRejection` 是 DSH 官方 API：做 Host/Origin 校验 + 浏览器会话认证，只有真正打开 DSH 页面的浏览器（带会话凭据）才能通过。`connection` 服务未挂载的极简组合里回退到原来的本地 Origin 校验，不会让插件在别的宿主里直接失效。

## 验证

- 新增测试：connection 拒绝时路由返回 403、信任请求返回 200；
- 本机实测：修复前 `GET /api/dsh-vocab-review/state` 无凭据返回 200，修复后返回 **401**（拦截生效），面板（同源、带会话）照常工作；
- 测试 31 → **32 项**，`npm test` 全绿。

## 其他

- 已在 awesome-dsh-plugin 提交后续 PR 更新我们条目的描述：删除「HTTP routes have no DSH access check」这句提示（问题已修复），并补上 v2.1.0 的「划线图附带未划线考试高频词」能力。
- 版本 2.1.0 → **2.1.1**。Host 改动：在插件管理里禁用→启用 `dsh-vocab-review`；面板无需刷新（无 Client 改动）。
