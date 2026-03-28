/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    appDir: true
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


