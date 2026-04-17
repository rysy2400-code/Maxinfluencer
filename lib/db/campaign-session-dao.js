// Campaign Session 数据访问对象（DAO）
// 用于保存和查询 Campaign 会话草稿；表名为 tiktok_campaign_sessions（若不存在则退化为 campaign_sessions）
const SESSION_TABLE = "tiktok_campaign_sessions";

import { queryTikTok } from "./mysql-tiktok.js";
import { randomUUID } from 'crypto';

/**
 * 入库前对 messages / context 做一次“瘦身”：
 * - 保留对话的业务语义
 * - 移除特别大的中间态字段（截图、browserSteps 等）
 * 这样既能把完整对话存在 MySQL，又不会因为 base64 截图 / 长 detail 把单行撑爆。
 */
function sanitizeMessagesForStorage(messages) {
  if (!Array.isArray(messages)) return [];

  // 目前的约定：message 结构主要是 { role, content, thinking?, ... }
  // 我们只动 thinking 里的大字段，其余字段原样保留
  return messages.map((msg) => {
    if (!msg || typeof msg !== 'object') return msg;

    const sanitized = { ...msg };

    if (sanitized.thinking && typeof sanitized.thinking === 'object') {
      const thinking = { ...sanitized.thinking };

      // screenshots: base64 / 大图数据，不进 DB
      if (thinking.screenshots) {
        // 完全移除字段，而不是存一个空数组，减小 JSON 体积
        delete thinking.screenshots;
      }

      // browserSteps: 里面的 detail 文本会非常长，只用于“流式过程感”，不需要长期持久化
      if (thinking.browserSteps) {
        delete thinking.browserSteps;
      }

      sanitized.thinking = thinking;
    }

    return sanitized;
  });
}

function sanitizeContextForStorage(context) {
  if (!context || typeof context !== 'object') return context || {};
  // 目前 context 里主要是 workflowState、产品 / campaign / 红人画像等结构化数据，
  // 一般不会有大图或超长 detail，这里先原样返回。
  // 如果未来在 context 里也挂载了截图、browserSteps，再按需在这里做裁剪。
  return context;
}

/**
 * 创建新的 Campaign Session
 * @param {Object} sessionData - 会话数据
 * @param {string} sessionData.title - 会话标题（可选，默认自动生成）
 * @param {Array} sessionData.messages - 消息数组（必填）
 * @param {Object} sessionData.context - 上下文对象（可选）
 * @param {string} sessionData.status - 状态：'draft' | 'published'（默认 'draft'）
 * @returns {Promise<Object>} - 创建结果 {success: boolean, session: Object, message: string}
 */
export async function createCampaignSession(sessionData) {
  try {
    const id = randomUUID();
    const title = sessionData.title || '';
    const status = sessionData.status || 'draft';
    const rawMessages = Array.isArray(sessionData.messages) ? sessionData.messages : [];
    const rawContext = sessionData.context || {};

    // 入库前统一清洗，避免把 screenshots / browserSteps 等大字段写进 MySQL
    const messages = sanitizeMessagesForStorage(rawMessages);
    const context = sanitizeContextForStorage(rawContext);

    // 验证必填字段
    if (!Array.isArray(messages)) {
      throw new Error('messages 必须是数组');
    }

    // 将 messages 和 context 转为 JSON 字符串
    const messagesJson = JSON.stringify(messages);
    const contextJson = JSON.stringify(context);

    const sql = `
      INSERT INTO ${SESSION_TABLE} (id, title, status, messages, context, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NOW(), NOW())
    `;

    await queryTikTok(sql, [id, title, status, messagesJson, contextJson]);

    // 返回创建的 session
    const session = {
      id,
      title,
      status,
      messages,
      context,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return {
      success: true,
      session,
      message: '会话创建成功',
    };
  } catch (error) {
    console.error('[CampaignSessionDAO] 创建会话失败:', error);
    return {
      success: false,
      session: null,
      message: error.message || '创建会话失败',
    };
  }
}

/**
 * 获取所有 Campaign Sessions（按更新时间倒序）
 * @param {Object} options - 查询选项
 * @param {string} options.status - 筛选状态：'draft' | 'published' | null（全部）
 * @param {number} options.limit - 限制返回数量（默认 50）
 * @returns {Promise<Array>} - Session 数组
 */
export async function getAllCampaignSessions(options = {}) {
  try {
    const status = options.status || null;
    const limit = options.limit || 50;
    const includeMessages = options.includeMessages !== undefined ? !!options.includeMessages : true;

    let sql = `
      SELECT id, title, status${includeMessages ? ', messages, context' : ''}, created_at, updated_at
      FROM ${SESSION_TABLE}
    `;
    const params = [];

    if (status) {
      if (status === "published") {
        // 已发布列表默认隐藏已删除 campaign（软删除）
        sql += `
          WHERE status = ?
            AND (
              NOT EXISTS (
                SELECT 1
                FROM tiktok_campaign tc
                WHERE tc.session_id = ${SESSION_TABLE}.id
              )
              OR EXISTS (
                SELECT 1
                FROM tiktok_campaign tc
                WHERE tc.session_id = ${SESSION_TABLE}.id
                  AND tc.status <> 'deleted'
              )
            )
        `;
      } else {
        sql += " WHERE status = ?";
      }
      params.push(status);
    }

    // LIMIT 不能使用参数绑定，必须直接拼接（limit 是数字，安全）
    const safeLimit = parseInt(limit, 10) || 50;

    // 已发布的 Campaign：按创建时间倒序（更接近“发布时间”）
    // 其他状态（草稿等）：仍按最近编辑时间倒序
    if (status === 'published') {
      sql += ` ORDER BY created_at DESC LIMIT ${safeLimit}`;
    } else {
      sql += ` ORDER BY updated_at DESC LIMIT ${safeLimit}`;
    }

    const rows = await queryTikTok(sql, params);

    // 解析 JSON 字段
    return rows.map(row => {
      try {
        return {
          id: row.id,
          title: row.title,
          status: row.status,
          ...(includeMessages
            ? {
                messages: typeof row.messages === 'string' ? JSON.parse(row.messages) : row.messages,
                context: row.context ? (typeof row.context === 'string' ? JSON.parse(row.context) : row.context) : {},
              }
            : {}),
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
          updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        };
      } catch (parseError) {
        console.error('[CampaignSessionDAO] 解析会话数据失败:', parseError, row);
        // 返回基础数据，即使解析失败
        return {
          id: row.id,
          title: row.title || '解析失败',
          status: row.status,
          ...(includeMessages ? { messages: [], context: {} } : {}),
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
          updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        };
      }
    });
  } catch (error) {
    console.error('[CampaignSessionDAO] 获取会话列表失败:', error);
    // 检查是否是表不存在的错误
    if (error.code === 'ER_NO_SUCH_TABLE' || error.message?.includes("doesn't exist")) {
      const tableError = new Error(`数据库表 ${SESSION_TABLE} 不存在，请先执行 SQL 创建表`);
      tableError.code = 'TABLE_NOT_EXISTS';
      throw tableError;
    }
    throw error;
  }
}

/**
 * 根据 ID 获取单个 Campaign Session
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<Object|null>} - Session 对象或 null
 */
export async function getCampaignSessionById(sessionId) {
  try {
    if (!sessionId) {
      return null;
    }

    const sql = `
      SELECT id, title, status, messages, context, created_at, updated_at
      FROM ${SESSION_TABLE}
      WHERE id = ?
    `;

    const rows = await queryTikTok(sql, [sessionId]);

    if (rows.length === 0) {
      return null;
    }

    const row = rows[0];

    return {
      id: row.id,
      title: row.title,
      status: row.status,
      messages: typeof row.messages === 'string' ? JSON.parse(row.messages) : row.messages,
      context: row.context ? (typeof row.context === 'string' ? JSON.parse(row.context) : row.context) : {},
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  } catch (error) {
    console.error('[CampaignSessionDAO] 获取会话失败:', error);
    throw error;
  }
}

/**
 * 更新 Campaign Session
 * @param {string} sessionId - 会话 ID
 * @param {Object} updates - 要更新的字段
 * @param {string} updates.title - 标题（可选）
 * @param {string} updates.status - 状态（可选）
 * @param {Array} updates.messages - 消息数组（可选）
 * @param {Object} updates.context - 上下文对象（可选）
 * @returns {Promise<Object>} - 更新结果 {success: boolean, session: Object|null, message: string}
 */
export async function updateCampaignSession(sessionId, updates) {
  try {
    if (!sessionId) {
      throw new Error('sessionId 是必填字段');
    }

    // 构建动态更新 SQL
    const updateFields = [];
    const params = [];

    if (updates.title !== undefined) {
      updateFields.push('title = ?');
      params.push(updates.title);
    }

    if (updates.status !== undefined) {
      updateFields.push('status = ?');
      params.push(updates.status);
    }

    if (updates.messages !== undefined) {
      // 入库前清洗 messages，移除截图 / browserSteps 等大字段
      const sanitizedMessages = sanitizeMessagesForStorage(updates.messages);
      updateFields.push('messages = ?');
      params.push(JSON.stringify(sanitizedMessages));
    }

    if (updates.context !== undefined) {
      const sanitizedContext = sanitizeContextForStorage(updates.context);
      updateFields.push('context = ?');
      params.push(JSON.stringify(sanitizedContext));
    }

    // 总是更新 updated_at
    updateFields.push('updated_at = NOW()');

    if (updateFields.length === 1) {
      // 只有 updated_at，没有实际更新内容
      return {
        success: true,
        session: await getCampaignSessionById(sessionId),
        message: '无需更新',
      };
    }

    params.push(sessionId);

    const sql = `
      UPDATE ${SESSION_TABLE}
      SET ${updateFields.join(', ')}
      WHERE id = ?
    `;

    await queryTikTok(sql, params);

    // 返回更新后的 session
    const session = await getCampaignSessionById(sessionId);

    return {
      success: true,
      session,
      message: '会话更新成功',
    };
  } catch (error) {
    console.error('[CampaignSessionDAO] 更新会话失败:', error);
    return {
      success: false,
      session: null,
      message: error.message || '更新会话失败',
    };
  }
}

/**
 * 向指定 Session 追加一条 Bin 的助手消息（品牌方在前端聊天框可见）
 * @param {string} sessionId - 会话 ID（tiktok_campaign_sessions.id）
 * @param {string} content - 消息正文（纯文本）
 * @returns {Promise<Object>} - { success: boolean, message: string }
 */
export async function appendBinMessageToSession(sessionId, content) {
  if (!sessionId || typeof content !== 'string') {
    return { success: false, message: 'sessionId 和 content 必填' };
  }
  const session = await getCampaignSessionById(sessionId);
  if (!session) {
    return { success: false, message: '会话不存在' };
  }
  const messages = Array.isArray(session.messages) ? [...session.messages] : [];
  messages.push({
    role: 'assistant',
    name: 'Bin',
    content: content.trim(),
  });
  return updateCampaignSession(sessionId, { messages });
}

/**
 * 删除 Campaign Session
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<Object>} - 删除结果 {success: boolean, message: string}
 */
export async function deleteCampaignSession(sessionId) {
  try {
    if (!sessionId) {
      throw new Error('sessionId 是必填字段');
    }

    const sql = `
      DELETE FROM ${SESSION_TABLE}
      WHERE id = ?
    `;

    await queryTikTok(sql, [sessionId]);

    return {
      success: true,
      message: '会话删除成功',
    };
  } catch (error) {
    console.error('[CampaignSessionDAO] 删除会话失败:', error);
    return {
      success: false,
      message: error.message || '删除会话失败',
    };
  }
}

