export const dynamic = "force-dynamic";

export const metadata = {
  title: "Maxinfluencer Agent",
  description: "Chat with Bin, your influencer marketing sales lead."
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          backgroundColor: "#050816",
          color: "white"
        }}
      >
        {children}
      </body>
    </html>
  );
}


