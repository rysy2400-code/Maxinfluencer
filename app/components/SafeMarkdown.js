"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { sanitizeAnalysisMarkdownForDisplay } from "../../lib/utils/sanitize-analysis-markdown.js";

const mdLink = ({ node, ...props }) => (
  <a {...props} target="_blank" rel="noopener noreferrer" />
);

/** 折叠 code/pre 子树为纯文本，用于判断是否空代码块（避免渲染灰底占位） */
function flattenMarkdownChildren(node) {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenMarkdownChildren).join("");
  if (React.isValidElement(node)) return flattenMarkdownChildren(node.props.children);
  return "";
}

function heading(Tag, fontSize, marginTop, marginBottom) {
  return function H({ children, ...props }) {
    return (
      <Tag
        style={{
          fontSize,
          fontWeight: 600,
          marginTop,
          marginBottom,
          color: "#111827",
          lineHeight: 1.35,
        }}
        {...props}
      >
        {children}
      </Tag>
    );
  };
}

const mdComponents = {
  a: mdLink,
  h1: heading("h1", "1.125rem", 12, 8),
  h2: heading("h2", "1.05rem", 10, 6),
  h3: heading("h3", "1rem", 8, 4),
  p: ({ children, ...props }) => (
    <p style={{ margin: "6px 0", lineHeight: 1.65 }} {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul style={{ margin: "6px 0", paddingLeft: 20, lineHeight: 1.6 }} {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol style={{ margin: "6px 0", paddingLeft: 20, lineHeight: 1.6 }} {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li style={{ margin: "2px 0" }} {...props}>
      {children}
    </li>
  ),
  hr: (props) => <hr style={{ border: "none", borderTop: "1px solid #E5E7EB", margin: "12px 0" }} {...props} />,
  blockquote: ({ children, ...props }) => (
    <blockquote
      style={{
        margin: "8px 0",
        paddingLeft: 12,
        borderLeft: "3px solid #E5E7EB",
        color: "#4B5563",
      }}
      {...props}
    >
      {children}
    </blockquote>
  ),
  pre: ({ children, ...props }) => {
    if (!flattenMarkdownChildren(children).trim()) return null;
    return (
      <pre
        style={{
          overflow: "auto",
          maxWidth: "100%",
          padding: 10,
          backgroundColor: "#F3F4F6",
          borderRadius: 8,
          fontSize: 11,
          lineHeight: 1.5,
          margin: "8px 0",
        }}
        {...props}
      >
        {children}
      </pre>
    );
  },
  code: ({ inline, children, ...props }) =>
    inline ? (
      <code
        style={{
          backgroundColor: "#F3F4F6",
          padding: "1px 5px",
          borderRadius: 4,
          fontSize: "0.92em",
        }}
        {...props}
      >
        {children}
      </code>
    ) : (
      <code style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }} {...props}>
        {children}
      </code>
    ),
};

/**
 * 可信域内的 LLM Markdown：GFM + rehype-sanitize（剥离危险 HTML/协议）。
 */
export function SafeMarkdown({ children, className, style }) {
  const raw = typeof children === "string" ? children : "";
  const src = sanitizeAnalysisMarkdownForDisplay(raw);
  if (!src.trim()) return null;
  return (
    <div className={className} style={style}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={mdComponents}
      >
        {src}
      </ReactMarkdown>
    </div>
  );
}
