export const metadata = {
  title: "Maxinfluencer 爬虫运维",
  description: "爬虫自愈事件与运维监控（独立于 Campaign 执行总览）",
};

export default function OpsLayout({ children }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        margin: 0,
        background: "#0f172a",
        color: "#e2e8f0",
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif",
      }}
    >
      {children}
    </div>
  );
}
