# 多阶段构建 - 大幅减少最终镜像体积
# 第一阶段：构建阶段
FROM node:18-alpine AS builder

# 设置工作目录
WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 安装所有依赖（包括 devDependencies）
RUN npm ci --only=production && npm cache clean --force

# 第二阶段：运行时阶段
FROM mcr.microsoft.com/playwright:v1.52.0-jammy AS runtime

# 设置工作目录
WORKDIR /app

# 只安装 Chromium（移除不需要的浏览器）
RUN npx playwright install chromium && \
    # 清理其他浏览器和不必要的文件
    rm -rf /ms-playwright/firefox-* && \
    rm -rf /ms-playwright/webkit-* && \
    rm -rf /ms-playwright/ffmpeg-* && \
    # 清理系统缓存
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    rm -rf /tmp/* && \
    rm -rf /var/tmp/*

# 从构建阶段复制依赖
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# 复制源代码
COPY . .

# 创建数据目录并设置权限
RUN mkdir -p /app/data && \
    chown -R pwuser:pwuser /app/data && \
    chown -R pwuser:pwuser /app

# 切换到非root用户
USER pwuser

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# 暴露端口
EXPOSE 3000

# 启动应用
CMD ["node", "server.js"]
