# 多 Agent 架构说明

## Phase 1-3 完成内容

✅ **Agent 框架搭建**
- 主 Agent: `BinAgent` (营销机构销售负责人)
- 子 Agent 1: `ProductInfoAgent` (确认产品信息)
- 子 Agent 2: `ContentRequirementAgent` (确认内容要求)
- Agent Router: 协调主 Agent 和子 Agent 的调用

✅ **临时存储 (localStorage)**
- 对话消息自动保存到 `localStorage`
- 上下文信息（产品信息、内容脚本）自动保存
- 刷新页面不丢失数据

✅ **Phase 2: 联网搜索工具**
- 实现 `web-scraper.js` 工具，可爬取产品链接的 HTML
- 使用 `cheerio` 解析 HTML
- 使用 LLM 从 HTML 中提取结构化产品信息
- 已集成到 `ProductInfoAgent`

✅ **Phase 3: 视频生成工具**
- 实现 `video-generator.js` 工具
- 支持 Runway、Pika 等视频生成 API（可配置）
- 已集成到 `ContentRequirementAgent`

## 安装依赖

```bash
npm install
```

## 环境变量配置

在 `.env.local` 文件中配置：

```bash
# DeepSeek API（必需）
DEEPSEEK_API_KEY=sk-xxx
DEEPSEEK_API_URL=https://api.deepseek.com/v1/chat/completions

# 视频生成 API（可选，不配置则返回占位符）
VIDEO_API_KEY=your_video_api_key
VIDEO_API_URL=https://api.runwayml.com/v1/generate
# 或
VIDEO_API_URL=https://api.pika.art/v1/generate
```

## 使用流程

1. **启动开发服务器**
   ```bash
   npm run dev
   ```

2. **测试产品信息提取**
   - 发送产品链接（如：`我有一个产品链接：https://example.com/product/123`）
   - Bin 会自动调用 `ProductInfoAgent` 爬取并提取产品信息
   - 提取的信息包括：品牌名、产品名、产品图片、产品类型、是否寄样

3. **测试内容脚本生成**
   - 先提取产品信息后，发送"生成内容脚本"或"帮我写脚本"
   - Bin 会自动调用 `ContentRequirementAgent` 生成脚本
   - 如果配置了视频生成 API，会同时生成参考视频

4. **数据存储**
   - 所有对话和上下文自动保存在浏览器 `localStorage`
   - 清除对话：点击右上角"清除对话"按钮

## 目录结构

```
lib/
  agents/
    base-agent.js              # Agent 基类
    bin-agent.js               # 主 Agent (Bin)
    product-info-agent.js      # 子 Agent 1 (产品信息)
    content-requirement-agent.js # 子 Agent 2 (内容要求)
  tools/
    web-scraper.js             # 联网搜索工具（Phase 2）
    video-generator.js         # 视频生成工具（Phase 3）
  utils/
    llm-client.js              # DeepSeek LLM 客户端
    agent-router.js            # Agent 路由协调器
```

## 功能说明

### Phase 2: 产品信息提取

**工作流程：**
1. 用户提供产品链接
2. `ProductInfoAgent` 调用 `web-scraper.js` 爬取 HTML
3. 使用 `cheerio` 解析 HTML，提取关键元素（title、meta、图片等）
4. 使用 LLM 从 HTML 内容中提取结构化产品信息
5. 返回产品信息并与用户确认

**提取的信息：**
- 产品链接
- 品牌名
- 产品名
- 产品图片 URL
- 产品类型（美妆、服饰、数码等）
- 是否寄样（true/false）

### Phase 3: 内容脚本和视频生成

**工作流程：**
1. 基于产品信息，使用 LLM 生成内容脚本（标题、脚本正文、关键要点）
2. 调用视频生成 API（如果配置）
3. 返回脚本和视频信息

**生成的内容：**
- 视频标题
- 完整脚本（30-60秒）
- 3-5个关键要点
- 参考视频（如果配置了 API）

## 下一步开发 (Phase 4)

- **Phase 4**: 用户确认发布 campaign 时写入 MySQL
  - 创建 `/api/campaigns/create` 接口
  - 一次性写入：conversations、messages、products、campaigns、content_scripts 表

