import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { activateCrawlerRelease } from "../db/crawler-ops-registry-dao.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function assertReleaseCommitExists(sha) {
  const normalized = String(sha || "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    const error = new Error("release SHA 必须是完整的 40 位 Git SHA");
    error.code = "INVALID_RELEASE_SHA";
    throw error;
  }
  try {
    await execFileAsync("git", ["-C", projectRoot, "cat-file", "-e", `${normalized}^{commit}`], {
      timeout: 5000,
      windowsHide: true,
    });
  } catch {
    const error = new Error("当前控制面仓库中不存在该 release commit");
    error.code = "RELEASE_COMMIT_MISSING";
    throw error;
  }
  return normalized;
}

export async function setActiveCrawlerRelease({ platform, sha, note, releasedBy }) {
  const verifiedSha = await assertReleaseCommitExists(sha);
  return activateCrawlerRelease({ platform, sha: verifiedSha, note, releasedBy });
}
