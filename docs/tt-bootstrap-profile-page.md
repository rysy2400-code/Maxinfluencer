# TikTok bootstrap 目标页改为红人主页（省 feed 后台流量）

## 背景

TikTok 爬虫的 worker 页面原来停在 For You 首页（`https://www.tiktok.com/`），
webapp 会持续刷新推荐流并懒加载 JS，实测后台流量：

- For You 首页稳态 ~36KB/min + 懒加载 JS 爆发（实测 305KB/min）
- 红人主页（如 `@tiktok`）稳态 ~4KB/min（仅心跳/埋点）

长任务（导入 1h）的 feed 开销从 2-18MB 降到 ~0.25MB。

## 改动清单（5 处）

1. `lib/tools/influencer-functions/tiktok/tiktok-api-client.js`
   - 新增 `resolveBootstrapUrl()`：读取 `TT_LITE_BOOTSTRAP_URL`，默认仍为首页
   - bootstrap / refresh / recover / force-bootstrap 共 4 处 goto 目标改为该函数
2. `lib/cdp/cdp-target-page.js`
   - `acquireTiktokCdpPage` 找不到健康 tab 时新开 tab 的 URL 改为
     `process.env.TT_LITE_BOOTSTRAP_URL || "https://www.tiktok.com/"`
   - （原硬编码首页，会导致工作 tab 悄悄回到首页）
3. `lib/tools/influencer-functions/tiktok/tiktok-direct-fetch.js`
   - `ensureTiktokOrigin` 的兜底导航目标同源处理
4. `config/worker-9225.cmd`（部署时生成的机器文件，不在仓库）
   - 新增 `set TT_LITE_BOOTSTRAP_URL=https://www.tiktok.com/@tiktok`
   - 推广到其他机器时在每台 worker cmd 中加同一行即可
5. `scripts/restart-chrome-9225.ps1`
   - Chrome 启动 URL 直接指 `https://www.tiktok.com/@tiktok`
   - 顺带修复了脚本双重 BOM 与 `$args` 保留变量问题

## 试点状态

- 仅 151 机器 / 9225 端口启用（env 变量只在 worker-9225.cmd 设置，不设即原行为）
- 已验证：页面稳定停在 @tiktok、后台流量 ~4KB/min、acrawler/搜索/国家/视频全链路正常、
  任务边界轮换正常、连续 10+ 任务 0 失败

## 推广注意事项

- 每台机器的 worker cmd 加 `set TT_LITE_BOOTSTRAP_URL=...`
- Chrome 启动 URL 指向同一主页（guard 启动用 about:blank 也可以，worker bootstrap 会导航过去）
- 页面选择：用稳定官方号（如 @tiktok），不要用不存在/空主页（错误页行为未长期验证）

## 附带：流量打点（可移除）

`lib/utils/tt-traffic-log.js` + api-client/direct-fetch 中的 `logTikTokTraffic` 是试点期间
的测量代码，记录每次 API/HTML 请求的响应字节到 `logs/traffic-9225.log`（硬编码文件名）。
推广前可改为按端口/环境变量命名，或整体移除。
