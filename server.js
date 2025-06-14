require('dotenv').config(); // 加载 .env 文件
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'weibo-proxy'; // 鉴权 token
const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const { chromium } = require('playwright');
const app = express();
const PORT = process.env.PORT || 3000;

// 强制输出缓冲区立即刷新的辅助函数
function logWithFlush(...args) {
    console.log(...args);
    // 强制刷新输出缓冲区
    if (process.stdout.write) {
        process.stdout.write('');
    }
}

function logErrorWithFlush(...args) {
    console.error(...args);
    // 强制刷新错误输出缓冲区
    if (process.stderr.write) {
        process.stderr.write('');
    }
}

// 中间件
app.use(cors());
app.use(express.json({
    limit: '50kb',
}));

app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.get('Content-Type')?.includes('application/json') && req.body === undefined) {
        return res.status(400).json({ error: '请求体JSON格式错误' });
    }
    next();
});

// 添加原始 body 解析，以便调试
app.use('/api', (req, res, next) => {
    if (req.path === '/post') {
        logWithFlush('请求方法:', req.method);
        logWithFlush('请求路径:', req.path);
        logWithFlush('请求类型:', req.get('Content-Type'));
        logWithFlush('请求内容:', req.body);
    } else {
        logWithFlush('请求路径:', req.path);
    }
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

app.use('/api', authenticateToken);

// 数据存储路径
const DATA_DIR = path.join(__dirname, 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');
fs.ensureDirSync(DATA_DIR);

// 全局变量
let browser = null;
let context = null;
let loginPage = null;
let isLoggedIn = false;
let lastSessionCheckTime = 0; // 添加会话检查时间戳

// 检查浏览器上下文是否有效
async function isContextValid() {
    if (!context) return false;
    
    try {
        // 检查上下文是否已关闭
        if (context._closed) return false;
        
        // 尝试获取页面列表
        const pages = context.pages();
        return true; // 如果能获取到页面列表，说明上下文是有效的
    } catch (error) {
        logWithFlush('[上下文检查] 上下文无效:', error.message);
        return false;
    }
}

// 改进的浏览器初始化，增加稳定性
async function initBrowser() {
    try {
        // 启动浏览器
        if (!browser || !browser.isConnected()) {
            if (browser) {
                await browser.close().catch(() => {});
            }
            logWithFlush('[浏览器] 启动浏览器...');
            browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                    '--disable-web-security', '--disable-features=VizDisplayCompositor',
                    '--disable-gpu', '--disable-extensions', '--no-first-run', '--disable-default-apps',
                    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding', '--memory-pressure-off',
                    // 新增优化参数
                    '--max_old_space_size=384', '--disable-background-networking',
                    '--disable-ipc-flooding-protection', '--disable-features=Translate,BackForwardCache,AcceptCHFrame,VizDisplayCompositor',
                    '--disable-hang-monitor', '--disable-prompt-on-repost', '--disable-domain-reliability'
                ]
            });
        }
        
        // 检查并创建上下文
        const contextValid = await isContextValid();
        if (!contextValid) {
            if (context) {
                logWithFlush('[浏览器] 关闭旧的上下文...');
                await context.close().catch(() => {});
            }
            
            logWithFlush('[浏览器] 创建新的浏览器上下文...');
            const sessionData = await loadSession();
            const contextOptions = {
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            };
            if (sessionData) {
                contextOptions.storageState = sessionData;
                logWithFlush('[浏览器] 使用已保存的会话数据');
            }
            context = await browser.newContext(contextOptions);
            
            // 重置登录页面
            loginPage = null;
        }
        
        logWithFlush('[浏览器] 浏览器和上下文初始化完成');
    } catch (error) {
        logErrorWithFlush('[浏览器] 浏览器初始化失败:', error);
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        context = null;
        browser = null;
        loginPage = null;
        throw error;
    }
}

// 保存会话
async function saveSession() {
    if (context && await isContextValid()) {
        try {
            const sessionData = await context.storageState();
            await fs.writeJson(SESSION_FILE, sessionData);
            logWithFlush('[会话] 会话已保存');
        } catch (error) {
            logErrorWithFlush('[会话] 保存会话失败:', error);
        }
    }
}

// 加载会话
async function loadSession() {
    try {
        if (await fs.pathExists(SESSION_FILE)) {
            const sessionData = await fs.readJson(SESSION_FILE);
            logWithFlush('[会话] 会话已加载');
            return sessionData;
        }
    } catch (error) {
        logWithFlush('[会话] 加载会话失败:', error.message);
    }
    return null;
}

// 优化的登录状态检查
async function checkLoginStatus() {
    const maxRetries = 2;
    let lastError;
    const now = Date.now();
    
    // 如果最近5秒内已经检查过且状态为已登录，直接返回
    if (isLoggedIn && (now - lastSessionCheckTime) < 5000) {
        logWithFlush('[登录检查] 使用缓存的登录状态: 已登录');
        return true;
    }
    
    for (let i = 0; i < maxRetries; i++) {
        let page = null;
        try {
            logWithFlush(`[登录检查] 检查登录状态 (尝试 ${i + 1}/${maxRetries})`);
            await initBrowser();
            
            page = await context.newPage();
            
            await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
            
            try {
                await page.waitForSelector('button[title="发微博"]', { timeout: 5000 });
                isLoggedIn = true;
                lastSessionCheckTime = now;
                logWithFlush('[登录检查] ✅ 用户已登录');
                return true;
            } catch {
                isLoggedIn = false;
                lastSessionCheckTime = now;
                logWithFlush('[登录检查] ❌ 用户未登录');
                return false;
            }
        } catch (error) {
            lastError = error;
            logErrorWithFlush(`[登录检查] 登录状态检查失败 (尝试 ${i + 1}):`, error.message);
            if (i < maxRetries - 1) {
                logWithFlush('[登录检查] 等待 2 秒后重试...');
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } finally {
            if (page) {
                await page.close().catch(e => logErrorWithFlush('[登录检查] 关闭页面失败:', e.message));
            }
        }
    }
    
    logErrorWithFlush('[登录检查] 所有重试都失败了');
    isLoggedIn = false;
    lastSessionCheckTime = now;
    throw lastError || new Error('检查登录状态失败');
}

// 改进的二维码获取
async function getQRCode() {
    const maxRetries = 2;
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            logWithFlush(`[二维码] 获取二维码 (尝试 ${i + 1}/${maxRetries})`);
            await initBrowser();
            
            // 如果之前有未关闭的登录页，先关掉，防止资源泄露
            if (loginPage && !loginPage.isClosed()) {
                await loginPage.close();
            }
            
            loginPage = await context.newPage();
            
            await loginPage.goto('https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog', {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            });
            
            await loginPage.waitForSelector('img[src*="qr.weibo.cn"]', { timeout: 10000 });
            const qrCodeUrl = await loginPage.getAttribute('img[src*="qr.weibo.cn"]', 'src');
            
            if (qrCodeUrl) {
                logWithFlush('[二维码] ✅ 二维码获取成功');
                return qrCodeUrl;
            } else {
                throw new Error('未找到二维码');
            }
        } catch (error) {
            lastError = error;
            logErrorWithFlush(`[二维码] 获取二维码失败 (尝试 ${i + 1}):`, error.message);
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    
    throw lastError || new Error('获取二维码失败');
}

// 检查扫码状态
async function checkScanStatus() {
    try {
        if (!loginPage || loginPage.isClosed()) {
            return { status: 'error', message: '登录页面已关闭，请刷新二维码' };
        }
        
        await loginPage.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        const currentUrl = loginPage.url();
        logWithFlush('[扫码状态] 当前页面URL:', currentUrl);
        
        if (currentUrl.includes('weibo.com') && !currentUrl.includes('passport')) {
            isLoggedIn = true;
            lastSessionCheckTime = Date.now();
            await saveSession();
            logWithFlush('[扫码状态] ✅ 用户扫码登录成功！');
            await loginPage.close();
            loginPage = null;
            return { status: 'success', message: '登录成功' };
        }

        const errorElement = await loginPage.$('.txt_red').catch(() => null);
        if (errorElement) {
            const errorText = await errorElement.textContent();
            logWithFlush('[扫码状态] ❌ 扫码登录失败:', errorText);
            return { status: 'error', message: errorText };
        }

        const expiredElement = await loginPage.$('text=二维码已失效').catch(() => null);
        if (expiredElement) {
            logWithFlush('[扫码状态] ⏰ 二维码已过期');
            await loginPage.close();
            loginPage = null;
            return { status: 'error', message: '二维码已过期，请刷新' };
        }

        const statusElements = await loginPage.$$('.txt').catch(() => []);
        let statusMessage = '等待扫码';
        for (const element of statusElements) {
            const text = await element.textContent().catch(() => '');
            if (text.includes('扫描成功') || text.includes('请确认')) {
                statusMessage = '扫描成功，请在手机上确认登录';
                logWithFlush('[扫码状态] 📱 用户已扫码，等待确认');
                break;
            } else if (text.includes('等待') || text.includes('扫描')) {
                statusMessage = text;
                break;
            }
        }
        return { status: 'waiting', message: statusMessage };
    } catch (error) {
        logErrorWithFlush('[扫码状态] 检查扫码状态失败:', error.message);
        if (loginPage && !loginPage.isClosed()) {
            await loginPage.close();
            loginPage = null;
        }
        return { status: 'error', message: '检查状态失败: ' + error.message };
    }
}

// 改进的发送微博功能
async function postWeibo(content) {
    const maxRetries = 2;
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        let page = null;
        try {
            logWithFlush(`[发送微博] 开始发送微博 (尝试 ${i + 1}/${maxRetries})`);
            logWithFlush(`[发送微博] 微博内容: "${content}"`);
            
            if (!isLoggedIn) {
                // 如果状态显示未登录，先检查一下实际登录状态
                logWithFlush('[发送微博] 状态显示未登录，重新检查登录状态...');
                const loginStatus = await checkLoginStatus();
                if (!loginStatus) {
                    throw new Error('用户未登录');
                }
            }
            
            await initBrowser();
            
            page = await context.newPage();
            
            await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 20000 });

            logWithFlush('[发送微博] 等待发布框加载...');
            await page.waitForSelector('textarea[placeholder="有什么新鲜事想分享给大家？"]', { timeout: 10000 });

            logWithFlush('[发送微博] 清空并输入内容...');
            await page.fill('textarea[placeholder="有什么新鲜事想分享给大家？"]', content);

            logWithFlush('[发送微博] 等待发送按钮可用...');
            await page.waitForSelector('button:has-text("发送"):not([disabled])', { timeout: 10000 });

            logWithFlush('[发送微博] 点击发送按钮并等待响应...');
            const [response] = await Promise.all([
                page.waitForResponse(res => res.url().includes('/ajax/statuses/update') && res.status() === 200, { timeout: 15000 }),
                page.click('button:has-text("发送")'),
            ]);

            const result = await response.json();

            if (result.ok === 1) {
                logWithFlush('[发送微博] ✅ 微博发送成功!');
                return {
                    success: true, message: '微博发送成功',
                    weiboId: result.data?.idstr, content: result.data?.text_raw || content,
                };
            } else {
                throw new Error(`微博接口返回失败: ${result.msg || '未知错误'}`);
            }

        } catch (error) {
            lastError = error;
            logErrorWithFlush(`[发送微博] 发送微博失败 (尝试 ${i + 1}):`, error.message);
            if (i < maxRetries - 1) {
                logWithFlush('[发送微博] 等待 3 秒后重试...');
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        } finally {
            if (page) {
                await page.close().catch(e => logErrorWithFlush('[发送微博] 关闭页面失败:', e.message));
                logWithFlush('[发送微博] 页面已关闭，资源已释放');
            }
        }
    }
    
    logErrorWithFlush('[发送微博] ❌ 所有重试都失败了');
    throw lastError || new Error('发送微博失败');
}

// API路由
app.get('/api/status', async (req, res) => {
    try {
        logWithFlush('[API] 收到登录状态检查请求');
        const loginStatus = await checkLoginStatus();
        res.json({ isLoggedIn: loginStatus });
    } catch (error) {
        logErrorWithFlush('[API] 状态检查 API 错误:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/qrcode', async (req, res) => {
    try {
        logWithFlush('[API] 收到获取二维码请求');
        const qrCodeUrl = await getQRCode();
        res.json({ qrCodeUrl });
    } catch (error) {
        logErrorWithFlush('[API] 二维码 API 错误:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/scan-status', async (req, res) => {
    try {
        const status = await checkScanStatus();
        res.json(status);
    } catch (error) {
        logErrorWithFlush('[API] 扫码状态 API 错误:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/post', async (req, res) => {
    try {
        logWithFlush('[API] ========== 收到发送微博请求 ==========');
        const { content } = req.body;
        if (!content || typeof content !== 'string' || content.length > 2000) {
            return res.status(400).json({ error: '内容无效或过长' });
        }
        
        logWithFlush('[API] 开始处理微博发送...');
        const result = await postWeibo(content);
        logWithFlush('[API] ✅ 微博发送API处理完成');
        res.json(result);
    } catch (error) {
        logErrorWithFlush('[API] ❌ 发送微博 API 错误:', error.message);
        res.status(500).json({ error: error.message });
    } finally {
        logWithFlush('[API] ========================================');
    }
});

app.post('/api/logout', async (req, res) => {
    try {
        logWithFlush('[API] 收到退出登录请求');
        if (await fs.pathExists(SESSION_FILE)) {
            await fs.remove(SESSION_FILE);
            logWithFlush('[API] 会话文件已删除');
        }
        isLoggedIn = false;
        lastSessionCheckTime = 0;
        
        // 确保关闭可能存在的登录页面
        if (loginPage && !loginPage.isClosed()) {
            await loginPage.close();
            loginPage = null;
            logWithFlush('[API] 登录页面已关闭');
        }

        if (context) {
            await context.close();
            context = null;
            logWithFlush('[API] 浏览器上下文已关闭');
        }
        
        logWithFlush('[API] 退出登录完成');
        res.json({ success: true, message: '退出登录成功' });
    } catch (error) {
        logErrorWithFlush('[API] 退出登录 API 错误:', error);
        res.status(500).json({ error: error.message });
    }
});

// 健康检查端点
app.get('/health', (req, res) => {
    const healthInfo = { 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        isLoggedIn: isLoggedIn,
        browserStatus: browser ? 'running' : 'stopped'
    };
    logWithFlush('[健康检查]', healthInfo);
    res.json(healthInfo);
});

// 更精确的错误处理中间件
app.use((err, req, res, next) => {
    logErrorWithFlush('[错误处理] 错误详情:', err.message);
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: '请求体JSON格式错误' });
    }
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: '请求体过大' });
    }
    res.status(500).json({ error: '服务器内部错误' });
});

// 服务器关闭时清理资源
async function gracefulShutdown(signal) {
    logWithFlush(`[关闭] 收到 ${signal} 信号，正在优雅关闭服务器...`);
    try {
        if (browser) {
            logWithFlush('[关闭] 关闭浏览器...');
            await browser.close();
        }
        logWithFlush('[关闭] 资源清理完成');
    } catch (error) {
        logErrorWithFlush('[关闭] 清理资源时出错:', error);
    }
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

process.on('unhandledRejection', (reason, promise) => {
    logErrorWithFlush('[Promise拒绝] 未处理的 Promise 拒绝:', reason);
});

// 启动服务器
app.listen(PORT, () => {
    logWithFlush(`[启动] 🚀 服务器运行在端口 ${PORT}`);
    logWithFlush(`[启动] 🌐 访问地址: http://localhost:${PORT}`);
    logWithFlush(`[启动] ❤️ 健康检查: http://localhost:${PORT}/health`);
    logWithFlush(`[启动] 📝 日志输出已优化，支持实时显示`);
});
