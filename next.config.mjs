/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 小内存 Windows 构建：避免额外 webpack worker 占满堆（见 deploy-web / next memory）
  experimental: {
    webpackBuildWorker: false,
    // 小内存 / Windows VM：压低静态导出并行，减轻 Zone OOM（见 deploy-web 构建日志）
    cpus: 1,
    workerThreads: false,
  },
  webpack: (config, { isServer }) => {
    // cheerio 只在服务端使用，配置 webpack 正确处理
    if (isServer) {
      config.externals = config.externals || [];
      // 确保 cheerio 在服务端正确解析
    }
    return config;
  },
};

export default nextConfig;


