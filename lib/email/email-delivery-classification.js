const BOUNCE_SENDER_RE = /(?:^|<|\s)(?:mailer-daemon|mail-daemon|postmaster|bounce(?:s)?)[^@\s<>]*@/i;
const BOUNCE_SUBJECT_RE = /(?:delivery status notification|delivery failure|undeliver(?:able|ed)|mail delivery failed|returned mail|failure notice|邮件投递失败|退信)/i;
const BOUNCE_BODY_RE = /(?:diagnostic-code:|final-recipient:|status:\s*[245]\.[0-9]\.[0-9]|recipient address rejected|message could not be delivered)/i;

export function normalizeEmailAddress(value) {
  const text = String(value || "").trim().toLowerCase();
  const bracket = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  return (bracket?.[1] || text).trim();
}

export function normalizeMessageId(value) {
  return String(value || "").trim().replace(/^<|>$/g, "").toLowerCase();
}

export function isBounceEmail({ fromEmail, subject, bodyText, rawHeaders } = {}) {
  return (
    BOUNCE_SENDER_RE.test(String(fromEmail || "")) ||
    BOUNCE_SUBJECT_RE.test(String(subject || "")) ||
    BOUNCE_BODY_RE.test(`${rawHeaders || ""}\n${bodyText || ""}`)
  );
}
