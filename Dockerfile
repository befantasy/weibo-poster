FROM node:18-slim

# 安装系统依赖
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libxss1 \
    curl \
    libgconf-2-4 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制package.json
COPY package*.json ./

# 安装Node.js依赖
RUN npm install

# 安装 Playwright 推荐的所有依赖
RUN npx playwright install-deps

# 安装Playwright浏览器
RUN npx playwright install chromium

# 复制源代码
COPY . .

# 创建数据目录
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 3000

# 启动应用
CMD ["node", "server.js"]
