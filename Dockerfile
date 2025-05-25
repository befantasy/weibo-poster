FROM node:18-slim

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
