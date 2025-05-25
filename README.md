# 新浪微博代理发送服务

一个基于 Docker 的新浪微博代理发送服务，使用 Playwright 模拟真实用户操作，支持扫码登录和微博发送功能。

## 🚀 功能特性

- ✅ **Token 鉴权保护** - 支持 API Token 认证，确保服务安全
- ✅ **扫码登录** - 使用微博手机APP扫码登录
- ✅ **会话持久化** - 自动保存和恢复登录状态
- ✅ **美观的 Web 界面** - 现代化响应式设计
- ✅ **RESTful API** - 完整的 API 接口支持
- ✅ **Docker 容器化** - 一键部署，环境隔离
- ✅ **实时状态检查** - 自动检测扫码和登录状态
- ✅ **智能字符统计** - 字符计数和超限提醒
- ✅ **完善的错误处理** - 友好的错误提示和用户反馈
- ✅ **移动端适配** - 响应式设计，支持手机访问

## 📁 项目结构

```
weibo-proxy/
├── docker-compose.yml    # Docker Compose 配置
├── Dockerfile           # Docker 镜像构建文件
├── package.json         # Node.js 依赖配置
├── server.js           # 后端服务器主文件
├── .env                # 环境变量配置（需要创建）
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

### 2. 配置环境变量
创建 `.env` 文件并设置 API Token：
```bash
# 复制环境变量模板
cp .env.example .env

# 编辑 .env 文件
AUTH_TOKEN=your-secure-token-here
```

> **重要：** 请将 `your-secure-token-here` 替换为一个安全的随机字符串，这个 Token 将用于 API 访问鉴权。

### 3. 使用 Docker Compose 部署
```bash
# 构建并启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

### 4. 访问服务
- **Web 界面**: http://localhost:3000
- **API 接口**: http://localhost:3000/api/*

## 🔐 Token 鉴权

所有 API 接口都需要通过 Bearer Token 进行身份验证：

```bash
# 请求头格式
Authorization: Bearer your-token-here
```

### 在 Web 界面中配置 Token
1. 首次访问会显示 Token 配置页面
2. 输入在 `.env` 文件中设置的 `AUTH_TOKEN`
3. 点击"保存 Token"完成配置
4. Token 会被安全存储在浏览器本地存储中

## 🌐 API 接口

> **注意：** 所有 API 接口都需要在请求头中包含有效的 Bearer Token

### 检查登录状态
```http
GET /api/status
Authorization: Bearer your-token-here
```
**响应:**
```json
{
  "isLoggedIn": true
}
```

### 获取登录二维码
```http
GET /api/qrcode
Authorization: Bearer your-token-here
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
Authorization: Bearer your-token-here
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
Authorization: Bearer your-token-here
Content-Type: application/json

{
  "content": "要发送的微博内容"
}
```
**成功响应:**
```json
{
  "success": true,
  "message": "微博发送成功",
  "weiboId": "4962xxxxx",
  "content": "实际发送的内容"
}
```

### 退出登录
```http
POST /api/logout
Authorization: Bearer your-token-here
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

1. **配置 Token**: 首次访问输入 API Token
2. **扫码登录**: 使用微博手机APP扫描二维码登录
3. **发送微博**: 登录成功后，在文本框输入内容并点击发送
4. **管理会话**: 
   - 点击"设置"重新配置 Token
   - 点击"退出登录"清除登录状态

### API 调用示例

**使用 curl 发送微博:**
```bash
curl -X POST http://localhost:3000/api/post \
  -H "Authorization: Bearer your-token-here" \
  -H "Content-Type: application/json" \
  -d '{"content": "Hello from API!"}'
```

**使用 Python 发送微博:**
```python
import requests

url = "http://localhost:3000/api/post"
headers = {
    "Authorization": "Bearer your-token-here",
    "Content-Type": "application/json"
}
data = {"content": "Hello from Python!"}

response = requests.post(url, json=data, headers=headers)
print(response.json())
```

**使用 JavaScript 发送微博:**
```javascript
const response = await fetch('http://localhost:3000/api/post', {
    method: 'POST',
    headers: {
        'Authorization': 'Bearer your-token-here',
        'Content-Type': 'application/json'
    },
    body: JSON.stringify({
        content: 'Hello from JavaScript!'
    })
});

const result = await response.json();
console.log(result);
```

## ⚙️ 配置说明

### 环境变量
```bash
# API 鉴权 Token（必需）
AUTH_TOKEN=your-secure-token-here

# 服务端口（可选，默认 3000）
PORT=3000

# 运行环境（可选，默认 production）
NODE_ENV=production
```

### Docker 配置
- **端口映射**: 3000:3000
- **数据持久化**: ./data:/app/data（登录会话存储）
- **共享内存**: /dev/shm（Playwright 浏览器需要）
- **特权模式**: 需要 SYS_ADMIN 权限运行 Chromium

## 🔧 开发模式

如需在开发模式下运行：

```bash
# 安装依赖
npm install

# 安装 Playwright 浏览器
npx playwright install chromium

# 设置环境变量
export AUTH_TOKEN=your-dev-token

# 启动开发服务器
npm run dev
```

## 📋 技术栈

- **后端**: Node.js + Express.js
- **自动化**: Playwright (Chromium)
- **前端**: HTML5 + CSS3 + Vanilla JavaScript
- **容器化**: Docker + Docker Compose
- **存储**: JSON 文件存储 + LocalStorage
- **鉴权**: Bearer Token 认证

## 🔒 安全特性

- **API Token 鉴权**: 所有 API 接口都需要有效的 Bearer Token
- **会话隔离**: 每个用户的登录会话独立存储
- **错误处理**: 完善的错误处理机制，避免敏感信息泄露
- **输入验证**: 对用户输入进行严格验证和过滤

## 🚨 注意事项

1. **Token 安全**: 
   - 请使用强随机字符串作为 AUTH_TOKEN
   - 不要在代码中硬编码 Token
   - 定期更换 Token

2. **登录会话**: 
   - 登录会话自动保存在 `data/session.json` 文件中
   - 会话具有一定的有效期，过期后需要重新登录

3. **使用限制**: 
   - 遵守微博平台的使用条款和频率限制
   - 建议合理控制发送频率，避免被平台限制

4. **资源消耗**: 
   - Playwright 会占用一定的 CPU 和内存资源
   - 建议在具有足够资源的服务器上部署

5. **网络要求**: 
   - 需要稳定的网络连接访问微博服务
   - 确保服务器可以正常访问 weibo.com

## 🐛 故障排除

### 常见问题

**1. Token 认证失败**
```
错误：401 Unauthorized
解决：检查 .env 文件中的 AUTH_TOKEN 是否正确设置
```

**2. 二维码无法加载**
```
可能原因：网络连接问题或微博服务异常
解决方案：
- 检查网络连接
- 重启容器：docker-compose restart
- 查看详细日志：docker-compose logs -f
```

**3. 登录状态丢失**
```
可能原因：会话过期或 session.json 文件损坏
解决方案：
- 删除 data/session.json 文件
- 重新扫码登录
- 确认 Docker 数据卷挂载正确
```

**4. 发送微博失败**
```
可能原因：登录状态无效、内容违规或网络问题
解决方案：
- 确认登录状态正常
- 检查微博内容是否符合平台规范
- 查看服务器日志获取详细错误信息
```

**5. 容器启动失败**
```bash
# 查看详细启动日志
docker-compose logs weibo-proxy

# 重新构建镜像
docker-compose build --no-cache

# 检查端口占用
netstat -tulpn | grep 3000
```

### 日志查看
```bash
# 查看实时日志
docker-compose logs -f

# 查看最近的日志
docker-compose logs --tail=100

# 查看特定服务日志
docker-compose logs weibo-proxy
```

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

### 贡献指南

1. Fork 本项目
2. 创建特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

## 📞 支持

- **Issues**: 在 GitHub 上创建 Issue 报告问题或请求功能
- **Discussions**: 参与项目讨论和经验分享
- **Wiki**: 查看更多使用技巧和最佳实践

## 🎯 路线图

- [ ] 支持图片和视频上传
- [ ] 支持微博定时发送
- [ ] 添加微博内容模板功能
- [ ] 支持批量发送微博
- [ ] 添加发送统计和分析功能
- [ ] 支持多账号管理

---

**⭐ 如果这个项目对你有帮助，请给个 Star 支持一下！**
