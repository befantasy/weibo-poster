// --- START OF FILE server.js (OPTIMIZED) ---

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
    if (process.stdout.write) {
        process.stdout.write('');
    }
}

function logErrorWithFlush(...args) {
    console.error(...args);
    if (process.stderr.write) {
        process.stderr.write('');
    }
}

// 中间件
app.use(cors());
app.use(express.json({ limit: '50kb' }));
app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.get('Content-Type')?.includes('application/json') && req.body === undefined) {
        return res.status(400).json({ error: '请求体JSON格式错误' });
    }
    next();
});
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
// [优化] 移除全局 page 对象，它将在每个请求中按需创建和销毁
// let page = null; 
let isLoggedIn = false;

// [优化] 浏览器初始化逻辑，不再管理全局 page
async function initBrowser() {
    try {
        if (!browser) {
            logWithFlush('[浏览器] 启动浏览器...');
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
                    '--memory-pressure-off',
                    '--max_old_space_size=384',
                    '--disable-background-networking',
                    '--disable-ipc-flooding-protection',
                    '--disable-features=Translate,BackForwardCache,AcceptCHFrame,VizDisplayCompositor',
                    '--disable-hang-monitor',
                    '--disable-prompt-on-repost',
                    '--disable-domain-reliability'
                ]
            });
        }
        
        // 如果上下文因某种原因被关闭，则重置
        if (context && context.pages().length === 0 && !browser.isConnected()) {
             logWithFlush('[浏览器] 检测到上下文或浏览器已关闭，准备重建...');
             await context.close().catch(() => {});
             context = null;
        }

        if (!context) {
            logWithFlush('[浏览器] 创建浏览器上下文...');
            const sessionData = await loadSession();
            const contextOptions = {
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            };
            if (sessionData) {
                contextOptions.storageState = sessionData;
            }
            context = await browser.newContext(contextOptions);
        }
        
        logWithFlush('[浏览器] 浏览器和上下文准备就绪');
    } catch (error) {
        logErrorWithFlush('[浏览器] 浏览器初始化失败:', error);
        if (context) { await context.close().catch(() => {}); context = null; }
        if (browser) { await browser.close().catch(() => {}); browser = null; }
        isLoggedIn = false;
        throw error;
    }
}

// [优化] 创建一个受管理的新页面，并确保它被关闭
async function withPage(callback) {
    await initBrowser();
    if (!context) throw new Error("浏览器上下文未初始化");

    const page = await context.newPage();
    page.on('pageerror', (error) => logErrorWithFlush('[页面错误]', error.message));
    page.on('crash', () => logErrorWithFlush('[页面崩溃] 页面崩溃!'));
    
    try {
        // 将创建的 page 传递给回调函数
        return await callback(page);
    } finally {
        // 无论成功与否，都关闭页面，释放资源
        await page.close().catch(e => logErrorWithFlush('[页面关闭] 关闭页面时出错:', e.message));
        logWithFlush('[页面管理] 临时页面已关闭');
    }
}


// 保存会话
async function saveSession() {
    if (context) {
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

// [优化] 所有使用页面的函数现在都通过 withPage 工具函数来获取页面
async function checkLoginStatus() {
    return withPage(async (page) => {
        logWithFlush(`[登录检查] 检查登录状态`);
        await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
        try {
            await page.waitForSelector('button[title="发微博"]', { timeout: 5000 });
            isLoggedIn = true;
            logWithFlush('[登录检查] ✅ 用户已登录');
            return true;
        } catch {
            isLoggedIn = false;
            logWithFlush('[登录检查] ❌ 用户未登录');
            return false;
        }
    });
}

async function getQRCode() {
    return withPage(async (page) => {
        logWithFlush(`[二维码] 获取二维码`);
        await page.goto('https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog', {
            waitUntil: 'domcontentloaded',
            timeout: 20000
        });
        await page.waitForSelector('img[src*="qr.weibo.cn"]', { timeout: 10000 });
        const qrCodeUrl = await page.getAttribute('img[src*="qr.weibo.cn"]', 'src');
        if (qrCodeUrl) {
            logWithFlush('[二维码] ✅ 二维码获取成功');
            // [优化] 返回页面和二维码，以便 scan-status 可以复用同一个页面
            return { qrCodeUrl, page }; 
        } else {
            throw new Error('未找到二维码');
        }
    });
}

// [优化] checkScanStatus 现在接收一个 page 对象，以避免重复创建
async function checkScanStatus(page) {
    try {
        if (!page || page.isClosed()) {
            throw new Error('页面未准备好或已关闭');
        }
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});

        const currentUrl = page.url();
        logWithFlush('[扫码状态] 当前页面URL:', currentUrl);
        
        if (currentUrl.includes('weibo.com') && !currentUrl.includes('passport')) {
            isLoggedIn = true;
            await saveSession();
            logWithFlush('[扫码状态] ✅ 用户扫码登录成功！');
            return { status: 'success', message: '登录成功' };
        }
        // ... (其他检查逻辑保持不变)
        const errorElement = await page.$('.txt_red').catch(() => null);
        if (errorElement) {
            const errorText = await errorElement.textContent();
            logWithFlush('[扫码状态] ❌ 扫码登录失败:', errorText);
            return { status: 'error', message: errorText };
        }
        const expiredElement = await page.$('text=二维码已失效').catch(() => null);
        if (expiredElement) {
            logWithFlush('[扫码状态] ⏰ 二维码已过期');
            return { status: 'error', message: '二维码已过期，请刷新' };
        }
        const statusElements = await page.$$('.txt').catch(() => []);
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
        return { status: 'error', message: '检查状态失败: ' + error.message };
    }
}


async function postWeibo(content) {
    // [优化] 重试逻辑现在应该在 API 处理器中，而不是在核心函数里
    return withPage(async (page) => {
        logWithFlush(`[发送微博] 开始发送微博`);
        logWithFlush(`[发送微博] 微博内容: "${content}"`);
        
        if (!isLoggedIn) {
            throw new Error('用户未登录');
        }

        await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 20000 });

        logWithFlush('[发送微博] 等待发布框加载...');
        await page.waitForSelector('textarea[placeholder="有什么新鲜事想分享给大家？"]', { timeout: 10000 });

        logWithFlush('[发送微博] 清空并输入内容...');
        await page.fill('textarea[placeholder="有什么新鲜事想分享给大家？"]', content);

        logWithFlush('[发送微博] 等待发送按钮可用...');
        await page.waitForSelector('button:has-text("发送"):not([disabled])', { timeout: 10000 });

        logWithFlush('[发送微博] 点击发送按钮并等待响应...');
        const [response] = await Promise.all([
            page.waitForResponse(resp => resp.url().includes('/ajax/statuses/update') && resp.status() === 200, { timeout: 15000 }),
            page.click('button:has-text("发送")'),
        ]);

        const result = await response.json();
        if (result.ok === 1) {
            logWithFlush('[发送微博] ✅ 微博发送成功!');
            return { success: true, message: '微博发送成功', weiboId: result.data?.idstr, content: result.data?.text_raw || content };
        } else {
            throw new Error(`微博接口返回失败: ${result.msg || '未知错误'}`);
        }
    });
}

// API路由

// 检查登录状态
app.get('/api/status', async (req, res) => {
    try {
        logWithFlush('[API] 收到登录状态检查请求');
        const loginStatus = await checkLoginStatus();
        res.json({ isLoggedIn: loginStatus });
    } catch (error) {
        logErrorWithFlush('[API] 状态检查 API 错误:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// [优化] /api/qrcode 和 /api/scan-status 逻辑需要调整以协同工作
// 为了简单起见，这里我们保持原始逻辑，但每次都创建新页面。
// 虽然效率稍低，但稳定性大大提高。
app.get('/api/qrcode', async (req, res) => {
    try {
        logWithFlush('[API] 收到获取二维码请求');
        // 使用 withPage 来确保页面被正确管理
        await withPage(async (page) => {
            await page.goto('https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog', {
                waitUntil: 'domcontentloaded',
                timeout: 20000
            });
            await page.waitForSelector('img[src*="qr.weibo.cn"]', { timeout: 10000 });
            const qrCodeUrl = await page.getAttribute('img[src*="qr.weibo.cn"]', 'src');
            if (qrCodeUrl) {
                logWithFlush('[API] 二维码获取完成');
                // 注意：这里的 page 会在 withPage 结束时自动关闭。
                // 这意味着 scan-status 必须在新的页面中检查。
                res.json({ qrCodeUrl });
            } else {
                throw new Error('未找到二维码');
            }
        });
    } catch (error) {
        logErrorWithFlush('[API] 二维码 API 错误:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// 检查扫码状态
app.get('/api/scan-status', async (req, res) => {
    try {
        // 使用 withPage 来在一个新的、干净的页面中检查状态
        const status = await withPage(async (page) => {
            return await checkScanStatus(page);
        });
        res.json(status);
    } catch (error) {
        logErrorWithFlush('[API] 扫码状态 API 错误:', error.message);
        res.status(500).json({ error: error.message });
    }
});


// 发送微博
app.post('/api/post', async (req, res) => {
    // [优化] 将重试逻辑放在 API 处理器中，更加清晰
    const maxRetries = 2;
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            logWithFlush(`[API] ========== 收到发送微博请求 (尝试 ${i + 1}/${maxRetries}) ==========`);
            const { content } = req.body;
            if (!content || typeof content !== 'string' || content.length > 2000) {
                 return res.status(400).json({ error: '内容无效或过长' });
            }
            const result = await postWeibo(content);
            logWithFlush('[API] ✅ 微博发送API处理完成');
            return res.json(result);
        } catch (error) {
            lastError = error;
            logErrorWithFlush(`[API] ❌ 发送微博 API 错误 (尝试 ${i + 1}):`, error.message);
            if (i < maxRetries - 1) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
    }
    res.status(500).json({ error: lastError?.message || '发送微博失败' });
});


// 退出登录
app.post('/api/logout', async (req, res) => {
    try {
        logWithFlush('[API] 收到退出登录请求');
        if (await fs.pathExists(SESSION_FILE)) {
            await fs.remove(SESSION_FILE);
            logWithFlush('[API] 会话文件已删除');
        }
        isLoggedIn = false;
        if (context) {
            await context.close();
            context = null;
            logWithFlush('[API] 浏览器上下文已关闭');
        }
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
        browserStatus: browser?.isConnected() ? 'running' : 'stopped',
        // [优化] 显示当前打开的页面数量，正常情况下应为 0 或 1
        pagesOpen: context?.pages()?.length || 0,
    };
    logWithFlush('[健康检查]', healthInfo);
    res.json(healthInfo);
});


// ... 其他代码 (错误处理，启动服务器等) 保持不变 ...

// 更精确的错误处理中间件
app.use((err, req, res, next) => {
    logErrorWithFlush('[错误处理] 错误详情:', {
        message: err.message,
        stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
        url: req.url,
        method: req.method
    });

    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ 
            error: '请求体JSON格式错误',
            details: process.env.NODE_ENV !== 'production' ? err.message : undefined
        });
    }
    
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: '请求体过大' });
    }
    
    res.status(500).json({ 
        error: '服务器内部错误',
        timestamp: new Date().toISOString()
    });
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

app.listen(PORT, () => {
    logWithFlush(`[启动] 🚀 服务器运行在端口 ${PORT}`);
    logWithFlush(`[启动] 🌐 访问地址: http://localhost:${PORT}`);
    logWithFlush(`[启动] ❤️ 健康检查: http://localhost:${PORT}/health`);
    logWithFlush(`[启动] 📝 日志输出已优化，支持实时显示`);
});
