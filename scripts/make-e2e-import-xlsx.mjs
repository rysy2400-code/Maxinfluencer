import XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(__dirname, "e2e-import-list.xlsx");
const ws = XLSX.utils.aoa_to_sheet([
  ["红人用户名", "红人平台", "邮箱"],
  ["e2e_browser_user1", "tk", "e2e1@test.com"],
  ["e2e_browser_user2", "ins", ""],
]);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "Creators");
XLSX.writeFile(wb, out);
console.log("Wrote", out);
