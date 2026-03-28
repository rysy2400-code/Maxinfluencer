// 规则管理器
// 负责规则的加载、保存、版本管理

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

const RULES_CONFIG = {
  // 规则存储路径（按环境区分）
  rulesDir: process.env.RULES_CACHE_DIR || path.join(projectRoot, '.cache/rules'),
  
  // 是否允许自动更新规则（所有环境都允许）
  allowAutoUpdate: process.env.ALLOW_RULES_AUTO_UPDATE !== 'false',  // 默认允许
  
  // 是否允许写入规则文件（所有环境都允许）
  allowWriteRules: process.env.ALLOW_RULES_WRITE !== 'false',  // 默认允许
  
  // 当前环境
  environment: process.env.NODE_ENV || 'development',
  
  // 规则文件权限
  rulesFileMode: 0o644,
};

/**
 * 获取规则文件路径
 */
function getRulesPath() {
  const env = RULES_CONFIG.environment;
  const rulesDir = path.join(RULES_CONFIG.rulesDir, env);
  
  // 确保目录存在
  try {
    fs.mkdirSync(rulesDir, { recursive: true });
  } catch (e) {
    // 目录已存在，忽略错误
  }
  
  return path.join(rulesDir, 'tiktok-rules-current.json');
}

/**
 * 获取版本化规则文件路径
 */
function getVersionedRulesPath(version) {
  const env = RULES_CONFIG.environment;
  const rulesDir = path.join(RULES_CONFIG.rulesDir, env);
  return path.join(rulesDir, `tiktok-rules-v${version}.json`);
}

/**
 * 生成规则版本号
 */
function generateVersion() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * 生成 HTML 结构 hash（用于检测结构变化）
 */
function hashHTMLStructure(html) {
  // 提取关键结构特征
  const structure = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\s+/g, ' ')
    .substring(0, 10000); // 只取前 10000 字符
  
  return crypto.createHash('md5').update(structure).digest('hex').substring(0, 8);
}

/**
 * 获取默认规则（当前 htmlToCompactMarkdown 的逻辑）
 * 使用静态规则类型，规则引擎会调用 extractBasicData
 */
export function getDefaultRules() {
  return {
    version: 'default',
    type: 'static',
    description: '默认静态规则（当前 htmlToCompactMarkdown 函数）',
    generatedAt: new Date().toISOString(),
    environment: RULES_CONFIG.environment,
    // 注意：type: 'static' 时，规则引擎会使用 extractBasicData 函数
    // 该函数实现了 htmlToCompactMarkdown 的核心提取逻辑
  };
}

/**
 * 加载规则
 */
export function loadRules() {
  const rulesPath = getRulesPath();
  
  // 如果文件不存在，使用默认规则
  if (!fs.existsSync(rulesPath)) {
    console.log('[规则管理] 未找到规则文件，使用默认规则');
    return getDefaultRules();
  }
  
  try {
    const rulesContent = fs.readFileSync(rulesPath, 'utf-8');
    const rules = JSON.parse(rulesContent);
    console.log(`[规则管理] 加载规则: ${rules.version || 'unknown'}`);
    return rules;
  } catch (e) {
    console.error('[规则管理] 加载规则失败:', e.message);
    console.log('[规则管理] 使用默认规则');
    return getDefaultRules();
  }
}

/**
 * 保存规则
 */
export function saveRules(rules) {
  // 权限检查
  if (!RULES_CONFIG.allowWriteRules) {
    throw new Error('规则写入权限被禁用。设置 ALLOW_RULES_WRITE=true 启用。');
  }
  
  // 检查目录权限
  try {
    const rulesDir = path.dirname(getRulesPath());
    fs.accessSync(rulesDir, fs.constants.W_OK);
  } catch (e) {
    throw new Error(`规则目录不可写: ${path.dirname(getRulesPath())}`);
  }
  
  const rulesPath = getRulesPath();
  const version = rules.version || generateVersion();
  
  // 1. 保存版本化文件
  const versionedPath = getVersionedRulesPath(version);
  fs.writeFileSync(versionedPath, JSON.stringify(rules, null, 2), 'utf-8');
  console.log(`[规则管理] 保存版本化规则: ${versionedPath}`);
  
  // 2. 更新 current.json
  if (RULES_CONFIG.environment === 'production') {
    // 生产环境：创建备份后再更新
    const backupPath = `${rulesPath}.backup.${Date.now()}`;
    if (fs.existsSync(rulesPath)) {
      fs.copyFileSync(rulesPath, backupPath);
      console.log(`[规则管理] 创建备份: ${backupPath}`);
    }
  }
  
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf-8');
  console.log(`[规则管理] 更新当前规则: ${rulesPath}`);
  
  return { version, path: rulesPath };
}

/**
 * 检查写入权限
 */
export function checkWritePermission() {
  if (!RULES_CONFIG.allowWriteRules) {
    throw new Error('规则写入权限被禁用。设置 ALLOW_RULES_WRITE=true 启用。');
  }
  
  const rulesDir = path.dirname(getRulesPath());
  try {
    fs.accessSync(rulesDir, fs.constants.W_OK);
  } catch (e) {
    throw new Error(`规则目录不可写: ${rulesDir}`);
  }
}

export { RULES_CONFIG, hashHTMLStructure };

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../../');

const RULES_CONFIG = {
  // 规则存储路径（按环境区分）
  rulesDir: process.env.RULES_CACHE_DIR || path.join(projectRoot, '.cache/rules'),
  
  // 是否允许自动更新规则（所有环境都允许）
  allowAutoUpdate: process.env.ALLOW_RULES_AUTO_UPDATE !== 'false',  // 默认允许
  
  // 是否允许写入规则文件（所有环境都允许）
  allowWriteRules: process.env.ALLOW_RULES_WRITE !== 'false',  // 默认允许
  
  // 当前环境
  environment: process.env.NODE_ENV || 'development',
  
  // 规则文件权限
  rulesFileMode: 0o644,
};

/**
 * 获取规则文件路径
 */
function getRulesPath() {
  const env = RULES_CONFIG.environment;
  const rulesDir = path.join(RULES_CONFIG.rulesDir, env);
  
  // 确保目录存在
  try {
    fs.mkdirSync(rulesDir, { recursive: true });
  } catch (e) {
    // 目录已存在，忽略错误
  }
  
  return path.join(rulesDir, 'tiktok-rules-current.json');
}

/**
 * 获取版本化规则文件路径
 */
function getVersionedRulesPath(version) {
  const env = RULES_CONFIG.environment;
  const rulesDir = path.join(RULES_CONFIG.rulesDir, env);
  return path.join(rulesDir, `tiktok-rules-v${version}.json`);
}

/**
 * 生成规则版本号
 */
function generateVersion() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * 生成 HTML 结构 hash（用于检测结构变化）
 */
function hashHTMLStructure(html) {
  // 提取关键结构特征
  const structure = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\s+/g, ' ')
    .substring(0, 10000); // 只取前 10000 字符
  
  return crypto.createHash('md5').update(structure).digest('hex').substring(0, 8);
}

/**
 * 获取默认规则（当前 htmlToCompactMarkdown 的逻辑）
 * 使用静态规则类型，规则引擎会调用 extractBasicData
 */
export function getDefaultRules() {
  return {
    version: 'default',
    type: 'static',
    description: '默认静态规则（当前 htmlToCompactMarkdown 函数）',
    generatedAt: new Date().toISOString(),
    environment: RULES_CONFIG.environment,
    // 注意：type: 'static' 时，规则引擎会使用 extractBasicData 函数
    // 该函数实现了 htmlToCompactMarkdown 的核心提取逻辑
  };
}

/**
 * 加载规则
 */
export function loadRules() {
  const rulesPath = getRulesPath();
  
  // 如果文件不存在，使用默认规则
  if (!fs.existsSync(rulesPath)) {
    console.log('[规则管理] 未找到规则文件，使用默认规则');
    return getDefaultRules();
  }
  
  try {
    const rulesContent = fs.readFileSync(rulesPath, 'utf-8');
    const rules = JSON.parse(rulesContent);
    console.log(`[规则管理] 加载规则: ${rules.version || 'unknown'}`);
    return rules;
  } catch (e) {
    console.error('[规则管理] 加载规则失败:', e.message);
    console.log('[规则管理] 使用默认规则');
    return getDefaultRules();
  }
}

/**
 * 保存规则
 */
export function saveRules(rules) {
  // 权限检查
  if (!RULES_CONFIG.allowWriteRules) {
    throw new Error('规则写入权限被禁用。设置 ALLOW_RULES_WRITE=true 启用。');
  }
  
  // 检查目录权限
  try {
    const rulesDir = path.dirname(getRulesPath());
    fs.accessSync(rulesDir, fs.constants.W_OK);
  } catch (e) {
    throw new Error(`规则目录不可写: ${path.dirname(getRulesPath())}`);
  }
  
  const rulesPath = getRulesPath();
  const version = rules.version || generateVersion();
  
  // 1. 保存版本化文件
  const versionedPath = getVersionedRulesPath(version);
  fs.writeFileSync(versionedPath, JSON.stringify(rules, null, 2), 'utf-8');
  console.log(`[规则管理] 保存版本化规则: ${versionedPath}`);
  
  // 2. 更新 current.json
  if (RULES_CONFIG.environment === 'production') {
    // 生产环境：创建备份后再更新
    const backupPath = `${rulesPath}.backup.${Date.now()}`;
    if (fs.existsSync(rulesPath)) {
      fs.copyFileSync(rulesPath, backupPath);
      console.log(`[规则管理] 创建备份: ${backupPath}`);
    }
  }
  
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf-8');
  console.log(`[规则管理] 更新当前规则: ${rulesPath}`);
  
  return { version, path: rulesPath };
}

/**
 * 检查写入权限
 */
export function checkWritePermission() {
  if (!RULES_CONFIG.allowWriteRules) {
    throw new Error('规则写入权限被禁用。设置 ALLOW_RULES_WRITE=true 启用。');
  }
  
  const rulesDir = path.dirname(getRulesPath());
  try {
    fs.accessSync(rulesDir, fs.constants.W_OK);
  } catch (e) {
    throw new Error(`规则目录不可写: ${rulesDir}`);
  }
}

export { RULES_CONFIG, hashHTMLStructure };