# 新浪微博代理发送服务

一个基于 Docker 的新浪微博代理发送服务，使用 Playwright 模拟真实用户操作，支持扫码登录和微博发送功能。

## 🚀 功能特性

- ✅ 扫码登录新浪微博
- ✅ 自动保存和恢复登录状态
- ✅ 美观的 Web 界面
- ✅ RESTful API 支持
- ✅ Docker 容器化部署
- ✅ 实时扫码状态检查
- ✅ 字符计数和限制检查
- ✅ 错误处理和用户反馈

## 📁 项目结构

```
weibo-proxy/
├── docker-compose.yml    # Docker Compose 配置
├── Dockerfile           # Docker 镜像构建文件
├── package.json         # Node.js 依赖配置
├── server.js           # 后端服务器主文件
├── public/
│   └── index.html      # 前端界面
├── data/               # 数据存储目录（自动创建）
│   └── session.json    # 登录会话存储
└── README.md          # 项目说明文档
```

## 🛠️ 安装和部署

### 1. 克隆项目
```bash
git clone https://github.com/befantasy/weibo-proxy.git
cd weibo-proxy
```

### 2. 使用 Docker Compose 部署
```bash
# 构建并启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

### 3. 访问服务
- Web 界面: http://localhost:3000
- API 接口: http://localhost:3000/api/*

## 🌐 API 接口

### 检查登录状态
```http
GET /api/status
```
**响应:**
```json
{
  "isLoggedIn": true/false
}
```

### 获取登录二维码
```http
GET /api/qrcode
```
**响应:**
```json
{
  "qrCodeUrl": "https://qr.weibo.cn/..."
}
```

### 检查扫码状态
```http
GET /api/scan-status
```
**响应:**
```json
{
  "status": "waiting|success|error",
  "message": "状态信息"
}
```

### 发送微博
```http
POST /api/post
Content-Type: application/json

{
  "content": "要发送的微博内容"
}
```
**响应:**
```json
{
  "success": true,
  "message": "微博发送成功"
}
```

### 退出登录
```http
POST /api/logout
```
**响应:**
```json
{
  "success": true,
  "message": "退出登录成功"
}
```

## 💻 使用说明

### Web 界面使用

1. **首次访问**: 浏览器打开 http://localhost:3000
2. **扫码登录**: 使用微博手机APP扫描二维码登录
3. **发送微博**: 登录成功后，在文本框输入内容并点击发送
4. **退出登录**: 点击右上角退出按钮

### API 调用示例

**使用 curl 发送微博:**
```bash
curl -X POST http://localhost:3000/api/post \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello from API!"}'
```

**使用 Python 发送微博:**
```python
import requests

url = "http://localhost:3000/api/post"
data = {"content": "Hello from Python!"}

response = requests.post(url, json=data)
print(response.json())
```

## ⚙️ 配置说明

### 环境变量
- `PORT`: 服务端口，默认 3000
- `NODE_ENV`: 运行环境，默认 production

### Docker 配置
- **端口映射**: 3000:3000
- **数据持久化**: ./data:/app/data
- **共享内存**: /dev/shm (Playwright 需要)

## 🔧 开发模式

如需在开发模式下运行：

```bash
# 安装依赖
npm install

# 安装 Playwright 浏览器
npx playwright install chromium

# 启动开发服务器
npm run dev
```

## 📋 技术栈

- **后端**: Node.js + Express
- **自动化**: Playwright
- **前端**: HTML + CSS + JavaScript
- **容器化**: Docker + Docker Compose
- **存储**: JSON 文件存储

## 🚨 注意事项

1. **登录状态**: 登录会话会自动保存在 `data/session.json` 文件中
2. **安全性**: 请勿在生产环境中暴露敏感接口
3. **频率限制**: 微博平台可能有发送频率限制，请合理使用
4. **浏览器资源**: Playwright 会占用一定的系统资源
5. **网络稳定**: 需要稳定的网络连接来维持微博会话

## 🐛 故障排除

### 常见问题

**1. 二维码无法加载**
- 检查网络连接
- 确认微博服务是否正常
- 查看容器日志: `docker-compose logs`

**2. 登录状态丢失**
- 检查 `data/session.json` 文件是否存在
- 重新扫码登录
- 确认 Docker 数据卷挂载正确

**3. 发送微博失败**
- 确认已正确登录
- 检查微博内容是否符合规范
- 查看详细错误信息

**4. 容器启动失败**
```bash
# 查看详细日志
docker-compose logs weibo-proxy

# 重新构建镜像
docker-compose build --no-cache
```

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📞 支持

如有问题，请创建 GitHub Issue 或联系维护者。
