function safeJsonParse(v) {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export function encodeCursor({ sortTime, id }) {
  if (!sortTime || !id) return null;
  const payload = JSON.stringify({
    sortTime,
    id: Number(id),
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(String(cursor), "base64url").toString("utf8");
    const obj = safeJsonParse(raw);
    if (!obj || !obj.sortTime || !obj.id || Number.isNaN(Number(obj.id))) {
      return null;
    }
    return {
      sortTime: obj.sortTime,
      id: Number(obj.id),
    };
  } catch {
    return null;
  }
}

