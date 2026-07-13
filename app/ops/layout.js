export const metadata = {
  title: "Maxinfluencer 虚拟机运维",
  description: "14 台虚拟机矩阵：健康状态与任务消费快照（独立于 Campaign 执行总览）",
};

export default function OpsLayout({ children }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        margin: 0,
        background: "#F9FAFB",
        color: "#111827",
        fontFamily:
          "system-ui, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', sans-serif",
      }}
    >
      {children}
    </div>
  );
}
