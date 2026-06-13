import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Next/webpack 下 `import XLSX from "xlsx"` 的 default 可能为 undefined */
export function loadXlsx() {
  const mod = require("xlsx");
  return mod?.utils ? mod : mod?.default;
}
