require('dotenv').config(); // 加载 .env 文件
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'weibo-proxy'; // 鉴权 token
const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { chromium } = require('playwright');
const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());

// 修复后的JSON解析中间件
app.use(express.json({
    limit: '1mb',
    // 移除 verify 函数，让 express.json() 自己处理解析
    // verify 函数会导致请求体被读取两次，可能引发问题
}));

app.use('/api', (req, res, next) => {
    // 只在有请求体且Content-Type为application/json时验证
    if (req.method !== 'GET' && req.get('Content-Type')?.includes('application/json') && req.body === undefined) {
        return res.status(400).json({ error: '请求体JSON格式错误' });
    }
    next();
});

// 添加原始 body 解析，以便调试
app.use('/api', (req, res, next) => {
    console.log('请求方法:', req.method);
    console.log('请求路径:', req.path);
    console.log('请求类型:', req.get('Content-Type'));
    console.log('请求内容:', req.body);
    next();
});

app.use(express.static('public'));

// 鉴权中间件
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token || token !== AUTH_TOKEN) {
        return res.status(401).json({ error: '未经授权：Token 无效或缺失' });
    }

    next();
}

// 应用鉴权中间件到所有 /api 路由
app.use('/api', authenticateToken);

// 数据存储路径
const DATA_DIR = path.join(__dirname, 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');

// 确保数据目录存在
fs.ensureDirSync(DATA_DIR);

// 全局变量
let browser = null;
let context = null;
let page = null;
let isLoggedIn = false;

// 改进的浏览器初始化，增加稳定性
async function initBrowser() {
    try {
        if (!browser) {
            console.log('启动浏览器...');
            browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-web-security',
                    '--disable-features=VizDisplayCompositor',
                    '--disable-gpu',
                    '--disable-extensions',
                    '--no-first-run',
                    '--disable-default-apps',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--memory-pressure-off'
                ]
            });
        }
        
        // 如果上下文存在但页面崩溃了，重新创建
        if (context && page && page.isClosed()) {
            console.log('检测到页面已关闭，重新创建上下文...');
            await context.close();
            context = null;
            page = null;
        }
        
        if (!context) {
            console.log('创建浏览器上下文...');
            // 尝试恢复会话
            const sessionData = await loadSession();
            if (sessionData) {
                context = await browser.newContext({
                    storageState: sessionData,
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                });
            } else {
                context = await browser.newContext({
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                });
            }
        }
        
        if (!page || page.isClosed()) {
            console.log('创建新页面...');
            page = await context.newPage();
            
            // 添加页面错误监听
            page.on('pageerror', (error) => {
                console.error('页面错误:', error.message);
            });
            
            page.on('crash', () => {
                console.error('页面崩溃!');
                page = null; // 标记页面为无效
            });
        }
        
        console.log('浏览器初始化完成');
    } catch (error) {
        console.error('浏览器初始化失败:', error);
        // 清理状态
        if (context) {
            await context.close().catch(() => {});
            context = null;
        }
        if (browser) {
            await browser.close().catch(() => {});
            browser = null;
        }
        page = null;
        throw error;
    }
}

// 保存会话
async function saveSession() {
    if (context) {
        try {
            const sessionData = await context.storageState();
            await fs.writeJson(SESSION_FILE, sessionData);
            console.log('会话已保存');
        } catch (error) {
            console.error('保存会话失败:', error);
        }
    }
}

// 加载会话
async function loadSession() {
    try {
        if (await fs.pathExists(SESSION_FILE)) {
            const sessionData = await fs.readJson(SESSION_FILE);
            console.log('会话已加载');
            return sessionData;
        }
    } catch (error) {
        console.log('加载会话失败:', error.message);
    }
    return null;
}

// 改进的登录状态检查，增加重试机制
async function checkLoginStatus() {
    const maxRetries = 3;
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            console.log(`检查登录状态 (尝试 ${i + 1}/${maxRetries})`);
            await initBrowser();
            
            if (!page || page.isClosed()) {
                throw new Error('页面未准备好');
            }
            
            await page.goto('https://weibo.com', { 
                waitUntil: 'domcontentloaded',
                timeout: 20000 
            });
            
            // 检查是否存在登录用户信息
            try {
                await page.waitForSelector('button[title="发微博"]', { timeout: 5000 });
                isLoggedIn = true;
                console.log('用户已登录');
                return true;
            } catch {
                isLoggedIn = false;
                console.log('用户未登录');
                return false;
            }
        } catch (error) {
            lastError = error;
            console.error(`登录状态检查失败 (尝试 ${i + 1}):`, error.message);
            
            // 如果是页面崩溃，清理并重试
            if (error.message.includes('crash') || error.message.includes('Page closed')) {
                page = null;
                if (context) {
                    await context.close().catch(() => {});
                    context = null;
                }
            }
            
            if (i < maxRetries - 1) {
                console.log('等待 2 秒后重试...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    
    console.error('所有重试都失败了');
    isLoggedIn = false;
    throw lastError || new Error('检查登录状态失败');
}

// 改进的二维码获取
async function getQRCode() {
    const maxRetries = 3;
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            console.log(`获取二维码 (尝试 ${i + 1}/${maxRetries})`);
            await initBrowser();
            
            if (!page || page.isClosed()) {
                throw new Error('页面未准备好');
            }
            
            await page.goto('https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog', {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            });
            
            // 等待二维码加载
            await page.waitForSelector('img[src*="qr.weibo.cn"]', { timeout: 10000 });
            
            // 获取二维码图片URL
            const qrCodeUrl = await page.getAttribute('img[src*="qr.weibo.cn"]', 'src');
            
            if (qrCodeUrl) {
                console.log('二维码获取成功');
                return qrCodeUrl;
            } else {
                throw new Error('未找到二维码');
            }
        } catch (error) {
            lastError = error;
            console.error(`获取二维码失败 (尝试 ${i + 1}):`, error.message);
            
            // 如果是页面崩溃，清理并重试
            if (error.message.includes('crash') || error.message.includes('Page closed')) {
                page = null;
                if (context) {
                    await context.close().catch(() => {});
                    context = null;
                }
            }
            
            if (i < maxRetries - 1) {
                console.log('等待 2 秒后重试...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    
    throw lastError || new Error('获取二维码失败');
}

// 检查扫码状态
async function checkScanStatus() {
    try {
        if (!page || page.isClosed()) {
            throw new Error('页面未准备好');
        }
        
        // 等待最多 5 秒页面稳定（若正在跳转）
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});

        const currentUrl = page.url();
        if (currentUrl.includes('weibo.com') && !currentUrl.includes('passport')) {
            isLoggedIn = true;
            await saveSession();
            return { status: 'success', message: '登录成功' };
        }

        // 页面没跳转，检查是否有错误提示
        const errorElement = await page.$('.txt_red').catch(() => null);
        if (errorElement) {
            const errorText = await errorElement.textContent();
            return { status: 'error', message: errorText };
        }

        return { status: 'waiting', message: '等待扫码' };
    } catch (error) {
        console.error('检查扫码状态失败:', error.message);
        return { status: 'error', message: '检查状态失败: ' + error.message };
    }
}

// 改进的发送微博功能
async function postWeibo(content) {
    const maxRetries = 3;
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            console.log(`发送微博 (尝试 ${i + 1}/${maxRetries})`);
            
            if (!isLoggedIn) {
                throw new Error('用户未登录');
            }

            await initBrowser();
            
            if (!page || page.isClosed()) {
                throw new Error('页面未准备好');
            }
            
            await page.goto('https://weibo.com', { 
                waitUntil: 'domcontentloaded',
                timeout: 20000 
            });

            // 等待发布框加载
            await page.waitForSelector('textarea[placeholder="有什么新鲜事想分享给大家？"]', {
                timeout: 10000
            });

            // 清空并输入内容
            await page.fill('textarea[placeholder="有什么新鲜事想分享给大家？"]', '');
            await page.fill('textarea[placeholder="有什么新鲜事想分享给大家？"]', content);

            // 等待按钮可用（从 disabled 变成 enabled）
            await page.waitForSelector('button:has-text("发送"):not([disabled])', { timeout: 10000 });

            // === 监听发布接口响应 ===
            const [response] = await Promise.all([
                page.waitForResponse(response =>
                    response.url().includes('/ajax/statuses/update') &&
                    response.status() === 200,
                    { timeout: 15000 }
                ),
                page.click('button:has-text("发送")'),
            ]);

            const result = await response.json();

            if (result.ok === 1) {
                console.log('微博发送成功，微博ID:', result.data?.idstr);
                return {
                    success: true,
                    message: '微博发送成功',
                    weiboId: result.data?.idstr,
                    content: result.data?.text_raw || content,
                };
            } else {
                throw new Error(`微博接口返回失败: ${result.msg || '未知错误'}`);
            }

        } catch (error) {
            lastError = error;
            console.error(`发送微博失败 (尝试 ${i + 1}):`, error.message);
            
            // 如果是页面崩溃，清理并重试
            if (error.message.includes('crash') || error.message.includes('Page closed')) {
                page = null;
                if (context) {
                    await context.close().catch(() => {});
                    context = null;
                }
            }
            
            if (i < maxRetries - 1) {
                console.log('等待 3 秒后重试...');
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
    }
    
    throw lastError || new Error('发送微博失败');
}

// API路由

// 检查登录状态
app.get('/api/status', async (req, res) => {
    try {
        const loginStatus = await checkLoginStatus();
        res.json({ isLoggedIn: loginStatus });
    } catch (error) {
        console.error('状态检查 API 错误:', error);
        res.status(500).json({ error: error.message });
    }
});

// 获取二维码
app.get('/api/qrcode', async (req, res) => {
    try {
        const qrCodeUrl = await getQRCode();
        res.json({ qrCodeUrl });
    } catch (error) {
        console.error('二维码 API 错误:', error);
        res.status(500).json({ error: error.message });
    }
});

// 检查扫码状态
app.get('/api/scan-status', async (req, res) => {
    try {
        const status = await checkScanStatus();
        res.json(status);
    } catch (error) {
        console.error('扫码状态 API 错误:', error);
        res.status(500).json({ error: error.message });
    }
});

// 发送微博
app.post('/api/post', async (req, res) => {
    try {
        const { content } = req.body;
        if (!content || typeof content !== 'string') {
            return res.status(400).json({ error: '内容不能为空且必须是字符串' });
        }
        
        if (content.length > 2000) {
            return res.status(400).json({ error: '内容过长，最多2000字符' });
        }
        
        const result = await postWeibo(content);
        res.json(result);
    } catch (error) {
        console.error('发送微博 API 错误:', error);
        res.status(500).json({ error: error.message });
    }
});

// 退出登录
app.post('/api/logout', async (req, res) => {
    try {
        // 删除会话文件
        if (await fs.pathExists(SESSION_FILE)) {
            await fs.remove(SESSION_FILE);
            console.log('会话文件已删除');
        }
        
        // 重置状态
        isLoggedIn = false;
        
        // 关闭浏览器上下文
        if (context) {
            await context.close();
            context = null;
            page = null;
            console.log('浏览器上下文已关闭');
        }
        
        res.json({ success: true, message: '退出登录成功' });
    } catch (error) {
        console.error('退出登录 API 错误:', error);
        res.status(500).json({ error: error.message });
    }
});

// 健康检查端点
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        isLoggedIn: isLoggedIn,
        browserStatus: browser ? 'running' : 'stopped'
    });
});

// 更精确的错误处理中间件
app.use((err, req, res, next) => {
    console.error('错误详情:', {
        message: err.message,
        stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
        url: req.url,
        method: req.method
    });

    // 根据错误类型返回不同的响应
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ 
            error: '请求体JSON格式错误',
            details: process.env.NODE_ENV !== 'production' ? err.message : undefined
        });
    }
    
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: '请求体过大' });
    }
    
    // 其他未知错误
    res.status(500).json({ 
        error: '服务器内部错误',
        timestamp: new Date().toISOString()
    });
});

// 服务器关闭时清理资源
async function gracefulShutdown(signal) {
    console.log(`收到 ${signal} 信号，正在优雅关闭服务器...`);
    
    try {
        if (context) {
            console.log('关闭浏览器上下文...');
            await context.close();
        }
        if (browser) {
            console.log('关闭浏览器...');
            await browser.close();
        }
        console.log('资源清理完成');
    } catch (error) {
        console.error('清理资源时出错:', error);
    }
    
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// 捕获未处理的 Promise 拒绝
process.on('unhandledRejection', (reason, promise) => {
    console.error('未处理的 Promise 拒绝:', reason);
});

app.listen(PORT, () => {
    console.log(`服务器运行在端口 ${PORT}`);
    console.log(`访问地址: http://localhost:${PORT}`);
    console.log(`健康检查: http://localhost:${PORT}/health`);
});
