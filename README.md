# 微博自动发布系统部署指南

## 项目结构

```
weibo-poster/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── src/
│   └── index.js
├── data/           # 数据存储目录
└── README.md
```

## 快速部署

### 1. 克隆或创建项目目录

```bash
mkdir weibo-poster
cd weibo-poster
```

### 2. 创建必要的文件

将提供的 `Dockerfile`、`package.json`、`docker-compose.yml` 和 `src/index.js` 文件放在对应位置。

### 3. 创建数据目录

```bash
mkdir data
```

### 4. 使用 Docker Compose 部署

```bash
# 构建并启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

### 5. 访问服务

打开浏览器访问：`http://localhost:3000`

## 使用说明

### 登录流程

1. 访问 `http://localhost:3000`
2. 点击"获取二维码"按钮
3. 使用微博 APP 扫描二维码
4. 系统会自动检测登录状态
5. 登录成功后显示发布表单

### 发布微博

1. 在登录成功后的文本框中输入微博内容
2. 点击"发布微博"按钮
3. 系统会自动发布内容到微博

## API 接口

### 获取登录页面
```
GET /
```

### 获取二维码
```
GET /qr
```

### 检查登录状态
```
GET /check?session={sessionId}
```

### 发布微博
```
POST /post
Content-Type: application/json

{
  "content": "微博内容",
  "sessionId": "会话ID"
}
```

## 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| PORT | 3000 | 服务端口 |
| NODE_ENV | production | 运行环境 |

## 进阶配置

### 使用 Redis 作为存储

如果需要在多个实例间共享会话或需要持久化存储，可以启用 Redis：

1. 取消注释 `docker-compose.yml` 中的 Redis 相关配置
2. 安装 Redis 客户端：`npm install redis`
3. 修改 `src/index.js` 中的存储逻辑

### 自定义端口

```bash
# 修改端口为 8080
PORT=8080 docker-compose up -d
```

或在 `docker-compose.yml` 中修改：

```yaml
ports:
  - "8080:3000"
environment:
  - PORT=3000
```

### 生产环境部署

1. **反向代理**: 建议使用 Nginx 作为反向代理
2. **HTTPS**: 配置 SSL 证书
3. **监控**: 添加健康检查和日志监控
4. **备份**: 定期备份会话数据

#### Nginx 配置示例

```nginx
server {
    listen 80;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 故障排除

### 1. 容器启动失败

```bash
# 查看详细日志
docker-compose logs weibo-poster

# 检查容器状态
docker-compose ps
```

### 2. 二维码获取失败

- 检查网络连接
- 确认微博网站可访问
- 查看浏览器控制台错误

### 3. 登录检测失败

- 微博网站可能更新了页面结构
- 需要更新选择器
- 检查 cookies 是否正确保存

### 4. 发布失败

- 确认登录状态有效
- 检查微博内容是否符合规范
- 查看错误日志

## 安全注意事项

1. **不要在公网直接暴露服务**，建议使用 VPN 或内网访问
2. **定期更新依赖**，修复安全漏洞
3. **限制访问频率**，避免被微博反爬
4. **不要保存敏感信息**，如密码等

## 开发和调试

### 本地开发

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

### 调试模式

设置环境变量启用调试：

```bash
DEBUG=true npm start
```

### 自定义浏览器参数

修改 `src/index.js` 中的 `chromium.launch()` 参数：

```javascript
const browser = await chromium.launch({
  headless: false,  // 显示浏览器窗口
  slowMo: 1000,     // 减慢操作速度
  devtools: true,   // 打开开发者工具
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox'
  ]
});
```

## 更新和维护

### 更新应用

```bash
# 停止服务
docker-compose down

# 重新构建
docker-compose build --no-cache

# 启动服务
docker-compose up -d
```

### 清理数据

```bash
# 清理过期会话数据
docker-compose exec weibo-poster rm -rf /app/data/*
```

## 许可证

本项目仅供学习和研究使用，请遵守微博的服务条款和相关法律法规。
