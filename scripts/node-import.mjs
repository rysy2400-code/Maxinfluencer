/**
 * 以 ESM 方式加载任意 .js 脚本（避免 Windows 上未声明 type:module 时把含 import 的 .js 当 CJS 解析）。
 * 计划任务：node scripts/node-import.mjs scripts\xxx.js
 */
import path from "path";
import { pathToFileURL } from "url";

const target = process.argv[2];
if (!target) {
  console.error("用法: node scripts/node-import.mjs <相对或绝对路径.js>");
  process.exit(1);
}
const abs = path.isAbsolute(target) ? target : path.join(process.cwd(), target);
await import(pathToFileURL(abs).href);
