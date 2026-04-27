import os from "os";

export function detectPrimaryIpv4({ preferEnvKey } = {}) {
  if (preferEnvKey) {
    const v = String(process.env[preferEnvKey] || "").trim();
    if (v) return v;
  }
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets || {})) {
    for (const info of entries || []) {
      if (!info || info.family !== "IPv4" || info.internal) continue;
      return info.address;
    }
  }
  return null;
}

