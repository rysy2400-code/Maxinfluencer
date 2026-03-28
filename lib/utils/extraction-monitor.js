// 提取质量监控模块
// 用于记录提取成功率、失败原因，并实现智能切换
// 使用 TikTok 数据库存储统计信息

import { queryTikTok } from "../db/mysql-tiktok.js";

/**
 * 提取方式枚举
 */
export const ExtractionMethod = {
  FUNCTION: "function",      // 函数提取
  AI_AGENT: "ai_agent"      // AI Agent 提取
};

/**
 * 记录单次提取日志
 * @param {Object} logData - 日志数据
 * @param {string} logData.method - 提取方式
 * @param {string} logData.platform - 平台
 * @param {string} logData.username - 用户名（可选）
 * @param {boolean} logData.success - 是否成功
 * @param {Object} logData.extractedFields - 提取到的字段
 * @param {Array<string>} logData.missingFields - 缺失的字段
 * @param {string} logData.errorType - 错误类型（如果失败）
 * @param {string} logData.errorMessage - 错误消息（如果失败）
 * @param {Object} logData.errorDetails - 错误详情（如果失败）
 * @param {number} logData.extractionTimeMs - 提取耗时（毫秒）
 * @returns {Promise<void>}
 */
export async function logExtraction(logData) {
  try {
    const {
      method,
      platform,
      username = null,
      success = false,
      extractedFields = {},
      missingFields = [],
      errorType = null,
      errorMessage = null,
      errorDetails = null,
      extractionTimeMs = 0
    } = logData;

    // 计算数据完整度（基于必填字段）
    const requiredFields = ['username', 'displayName', 'profileUrl', 'followers'];
    const extractedRequiredFields = requiredFields.filter(field => 
      extractedFields[field] !== undefined && extractedFields[field] !== null && extractedFields[field] !== ''
    );
    const dataCompleteness = (extractedRequiredFields.length / requiredFields.length) * 100;

    // 数据准确度（暂时设为 100%，后续可以通过验证机制计算）
    const dataAccuracy = success ? 100 : 0;

    const sql = `
      INSERT INTO extraction_logs (
        extraction_method, platform, username, success,
        extracted_fields, missing_fields,
        error_type, error_message, error_details,
        extraction_time_ms, data_completeness, data_accuracy
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await queryTikTok(sql, [
      method,
      platform,
      username,
      success ? 1 : 0,
      JSON.stringify(extractedFields),
      JSON.stringify(missingFields),
      errorType,
      errorMessage,
      errorDetails ? JSON.stringify(errorDetails) : null,
      extractionTimeMs,
      dataCompleteness.toFixed(2),
      dataAccuracy.toFixed(2)
    ]);

  } catch (error) {
    // 数据库连接失败时，只记录警告，不影响主流程
    if (error.code === 'ECONNREFUSED' || error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.warn('[ExtractionMonitor] 数据库连接失败，跳过日志记录（不影响主流程）:', error.message);
    } else {
      console.error('[ExtractionMonitor] 记录提取日志失败:', error);
    }
    // 不抛出错误，避免影响主流程
  }
}

/**
 * 更新提取统计（基于时间窗口）
 * @param {string} method - 提取方式
 * @param {string} platform - 平台
 * @param {number} timeWindowHours - 时间窗口（小时，默认 24）
 * @returns {Promise<Object>} - 统计结果
 */
export async function updateExtractionStats(method, platform, timeWindowHours = 24) {
  try {
    const timeWindowStart = new Date(Date.now() - timeWindowHours * 60 * 60 * 1000);
    const timeWindowEnd = new Date();

    // 查询时间窗口内的提取日志
    const statsSql = `
      SELECT 
        COUNT(*) as total_attempts,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_extractions,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_extractions,
        AVG(extraction_time_ms) as avg_extraction_time_ms,
        SUM(extraction_time_ms) as total_extraction_time_ms,
        AVG(data_completeness) as avg_data_completeness,
        AVG(data_accuracy) as avg_data_accuracy
      FROM extraction_logs
      WHERE extraction_method = ?
        AND platform = ?
        AND created_at >= ?
        AND created_at <= ?
    `;

    const statsRows = await queryTikTok(statsSql, [method, platform, timeWindowStart, timeWindowEnd]);
    const stats = statsRows[0] || {};

    const totalAttempts = parseInt(stats.total_attempts) || 0;
    const successfulExtractions = parseInt(stats.successful_extractions) || 0;
    const failedExtractions = parseInt(stats.failed_extractions) || 0;
    const successRate = totalAttempts > 0 ? (successfulExtractions / totalAttempts) * 100 : 0;

    // 计算字段级别的成功率
    const fieldStatsSql = `
      SELECT 
        JSON_EXTRACT(extracted_fields, '$.*') as fields
      FROM extraction_logs
      WHERE extraction_method = ?
        AND platform = ?
        AND created_at >= ?
        AND created_at <= ?
        AND success = 1
    `;

    const fieldRows = await queryTikTok(fieldStatsSql, [method, platform, timeWindowStart, timeWindowEnd]);
    
    // 统计各字段的出现频率
    const fieldCounts = {};
    const requiredFields = ['username', 'displayName', 'profileUrl', 'avatarUrl', 'followers', 'bio', 'verified'];
    
    requiredFields.forEach(field => {
      fieldCounts[field] = 0;
    });

    fieldRows.forEach(row => {
      try {
        const fields = typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields;
        requiredFields.forEach(field => {
          if (fields[field] !== undefined && fields[field] !== null && fields[field] !== '') {
            fieldCounts[field]++;
          }
        });
      } catch (e) {
        // 忽略解析错误
      }
    });

    const fieldSuccessRates = {};
    requiredFields.forEach(field => {
      fieldSuccessRates[field] = successfulExtractions > 0 
        ? (fieldCounts[field] / successfulExtractions) * 100 
        : 0;
    });

    // 统计失败原因
    const failureReasonsSql = `
      SELECT 
        error_type,
        COUNT(*) as count
      FROM extraction_logs
      WHERE extraction_method = ?
        AND platform = ?
        AND created_at >= ?
        AND created_at <= ?
        AND success = 0
      GROUP BY error_type
    `;

    const failureRows = await queryTikTok(failureReasonsSql, [method, platform, timeWindowStart, timeWindowEnd]);
    const failureReasons = {};
    failureRows.forEach(row => {
      failureReasons[row.error_type || 'unknown'] = parseInt(row.count) || 0;
    });

    // 判断是否应该使用 AI Agent
    // 规则：如果成功率低于 70%，建议使用 AI Agent
    const shouldUseAIAgent = successRate < 70;
    const switchReason = shouldUseAIAgent 
      ? `函数提取成功率 ${successRate.toFixed(2)}% 低于阈值 70%，建议切换到 AI Agent`
      : `函数提取成功率 ${successRate.toFixed(2)}% 正常，继续使用函数提取`;

    // 插入或更新统计记录
    const upsertSql = `
      INSERT INTO extraction_stats (
        extraction_method, platform, time_window_start, time_window_end,
        total_attempts, successful_extractions, failed_extractions, success_rate,
        field_success_rates, failure_reasons,
        avg_extraction_time_ms, total_extraction_time_ms,
        data_completeness, data_accuracy,
        should_use_ai_agent, switch_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        total_attempts = VALUES(total_attempts),
        successful_extractions = VALUES(successful_extractions),
        failed_extractions = VALUES(failed_extractions),
        success_rate = VALUES(success_rate),
        field_success_rates = VALUES(field_success_rates),
        failure_reasons = VALUES(failure_reasons),
        avg_extraction_time_ms = VALUES(avg_extraction_time_ms),
        total_extraction_time_ms = VALUES(total_extraction_time_ms),
        data_completeness = VALUES(data_completeness),
        data_accuracy = VALUES(data_accuracy),
        should_use_ai_agent = VALUES(should_use_ai_agent),
        switch_reason = VALUES(switch_reason),
        updated_at = CURRENT_TIMESTAMP
    `;

    await queryTikTok(upsertSql, [
      method,
      platform,
      timeWindowStart,
      timeWindowEnd,
      totalAttempts,
      successfulExtractions,
      failedExtractions,
      successRate.toFixed(2),
      JSON.stringify(fieldSuccessRates),
      JSON.stringify(failureReasons),
      Math.round(parseFloat(stats.avg_extraction_time_ms) || 0),
      parseInt(stats.total_extraction_time_ms) || 0,
      parseFloat(stats.avg_data_completeness || 0).toFixed(2),
      parseFloat(stats.avg_data_accuracy || 0).toFixed(2),
      shouldUseAIAgent ? 1 : 0,
      switchReason
    ]);

    return {
      method,
      platform,
      timeWindow: { start: timeWindowStart, end: timeWindowEnd },
      totalAttempts,
      successfulExtractions,
      failedExtractions,
      successRate: parseFloat(successRate.toFixed(2)),
      fieldSuccessRates,
      failureReasons,
      avgExtractionTimeMs: Math.round(parseFloat(stats.avg_extraction_time_ms) || 0),
      dataCompleteness: parseFloat(stats.avg_data_completeness || 0).toFixed(2),
      dataAccuracy: parseFloat(stats.avg_data_accuracy || 0).toFixed(2),
      shouldUseAIAgent,
      switchReason
    };

  } catch (error) {
    // 数据库连接失败时，返回 null，不影响主流程
    if (error.code === 'ECONNREFUSED' || error.code === 'ER_ACCESS_DENIED_ERROR' || error.code === 'ENOTFOUND') {
      console.warn('[ExtractionMonitor] 数据库连接失败，无法更新统计（不影响主流程）:', error.message);
    } else {
      console.error('[ExtractionMonitor] 更新提取统计失败:', error);
    }
    return null;
  }
}

/**
 * 获取提取方式建议（智能切换）
 * @param {string} platform - 平台
 * @param {number} timeWindowHours - 时间窗口（小时，默认 24）
 * @returns {Promise<Object>} - 建议结果
 */
export async function getExtractionMethodSuggestion(platform, timeWindowHours = 24) {
  try {
    // 获取函数提取的统计
    const functionStats = await updateExtractionStats(ExtractionMethod.FUNCTION, platform, timeWindowHours);
    
    if (!functionStats || functionStats.totalAttempts === 0) {
      // 如果没有历史数据，默认使用函数提取
      return {
        recommendedMethod: ExtractionMethod.FUNCTION,
        reason: "无历史数据，默认使用函数提取",
        confidence: 0.5
      };
    }

    // 如果成功率低于阈值，建议使用 AI Agent
    if (functionStats.shouldUseAIAgent) {
      return {
        recommendedMethod: ExtractionMethod.AI_AGENT,
        reason: functionStats.switchReason,
        confidence: 1 - (functionStats.successRate / 100), // 成功率越低，置信度越高
        stats: functionStats
      };
    }

    // 否则继续使用函数提取
    return {
      recommendedMethod: ExtractionMethod.FUNCTION,
      reason: functionStats.switchReason,
      confidence: functionStats.successRate / 100,
      stats: functionStats
    };

  } catch (error) {
    // 数据库连接失败时，返回默认值，不影响主流程
    if (error.code === 'ECONNREFUSED' || error.code === 'ER_ACCESS_DENIED_ERROR' || error.code === 'ENOTFOUND') {
      console.warn('[ExtractionMonitor] 数据库连接失败，使用默认提取方式（不影响主流程）:', error.message);
    } else {
      console.error('[ExtractionMonitor] 获取提取方式建议失败:', error);
    }
    // 默认返回函数提取
    return {
      recommendedMethod: ExtractionMethod.FUNCTION,
      reason: "数据库连接失败或无历史数据，默认使用函数提取",
      confidence: 0.5
    };
  }
}

/**
 * 获取质量监控报告
 * @param {string} platform - 平台（可选）
 * @param {number} timeWindowHours - 时间窗口（小时，默认 24）
 * @returns {Promise<Object>} - 质量报告
 */
export async function getQualityReport(platform = null, timeWindowHours = 24) {
  try {
    const timeWindowStart = new Date(Date.now() - timeWindowHours * 60 * 60 * 1000);
    const timeWindowEnd = new Date();

    let sql = `
      SELECT 
        extraction_method,
        platform,
        COUNT(*) as total_attempts,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_extractions,
        AVG(data_completeness) as avg_completeness,
        AVG(data_accuracy) as avg_accuracy,
        AVG(extraction_time_ms) as avg_time_ms
      FROM extraction_logs
      WHERE created_at >= ? AND created_at <= ?
    `;

    const params = [timeWindowStart, timeWindowEnd];

    if (platform) {
      sql += ` AND platform = ?`;
      params.push(platform);
    }

    sql += ` GROUP BY extraction_method, platform`;

    const rows = await queryTikTok(sql, params);

    const report = {
      timeWindow: { start: timeWindowStart, end: timeWindowEnd },
      summary: {
        totalAttempts: 0,
        totalSuccessful: 0,
        overallSuccessRate: 0,
        avgCompleteness: 0,
        avgAccuracy: 0,
        avgTimeMs: 0
      },
      byMethod: {},
      byPlatform: {}
    };

    let totalAttempts = 0;
    let totalSuccessful = 0;
    let totalCompleteness = 0;
    let totalAccuracy = 0;
    let totalTimeMs = 0;

    rows.forEach(row => {
      const attempts = parseInt(row.total_attempts) || 0;
      const successful = parseInt(row.successful_extractions) || 0;
      const completeness = parseFloat(row.avg_completeness) || 0;
      const accuracy = parseFloat(row.avg_accuracy) || 0;
      const timeMs = parseFloat(row.avg_time_ms) || 0;

      totalAttempts += attempts;
      totalSuccessful += successful;
      totalCompleteness += completeness * attempts;
      totalAccuracy += accuracy * attempts;
      totalTimeMs += timeMs * attempts;

      // 按方法分组
      if (!report.byMethod[row.extraction_method]) {
        report.byMethod[row.extraction_method] = {
          totalAttempts: 0,
          successfulExtractions: 0,
          successRate: 0,
          avgCompleteness: 0,
          avgAccuracy: 0,
          avgTimeMs: 0
        };
      }

      report.byMethod[row.extraction_method].totalAttempts += attempts;
      report.byMethod[row.extraction_method].successfulExtractions += successful;

      // 按平台分组
      if (!report.byPlatform[row.platform]) {
        report.byPlatform[row.platform] = {
          totalAttempts: 0,
          successfulExtractions: 0,
          successRate: 0
        };
      }

      report.byPlatform[row.platform].totalAttempts += attempts;
      report.byPlatform[row.platform].successfulExtractions += successful;
    });

    // 计算总体统计
    report.summary.totalAttempts = totalAttempts;
    report.summary.totalSuccessful = totalSuccessful;
    report.summary.overallSuccessRate = totalAttempts > 0 
      ? parseFloat((totalSuccessful / totalAttempts) * 100).toFixed(2)
      : 0;
    report.summary.avgCompleteness = totalAttempts > 0
      ? parseFloat((totalCompleteness / totalAttempts)).toFixed(2)
      : 0;
    report.summary.avgAccuracy = totalAttempts > 0
      ? parseFloat((totalAccuracy / totalAttempts)).toFixed(2)
      : 0;
    report.summary.avgTimeMs = totalAttempts > 0
      ? Math.round(totalTimeMs / totalAttempts)
      : 0;

    // 计算各方法的成功率
    Object.keys(report.byMethod).forEach(method => {
      const methodData = report.byMethod[method];
      methodData.successRate = methodData.totalAttempts > 0
        ? parseFloat((methodData.successfulExtractions / methodData.totalAttempts) * 100).toFixed(2)
        : 0;
    });

    // 计算各平台的成功率
    Object.keys(report.byPlatform).forEach(platform => {
      const platformData = report.byPlatform[platform];
      platformData.successRate = platformData.totalAttempts > 0
        ? parseFloat((platformData.successfulExtractions / platformData.totalAttempts) * 100).toFixed(2)
        : 0;
    });

    return report;

  } catch (error) {
    console.error('[ExtractionMonitor] 获取质量报告失败:', error);
    return null;
  }
}
