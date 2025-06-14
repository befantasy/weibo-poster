// server.js
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
        logWithFlush('请求头:', req.headers);
        logWithFlush('请求体:', req.body);
    }
    next();
});

// Playwright 相关变量
let browser = null;
let context = null;
let loginPage = null; // 用于存储登录页面的实例，方便二维码刷新
let isLoggedIn = false;
const sessionFilePath = path.join(__dirname, 'data', 'session.json');

// 确保数据目录存在
fs.ensureDirSync(path.join(__dirname, 'data'));

// 会话管理
async function saveSession() {
    if (context) {
        try {
            const storageState = await context.storageState();
            await fs.writeJson(sessionFilePath, storageState);
            logWithFlush('[会话] 会话已保存');
        } catch (error) {
            logErrorWithFlush('[会话] 保存会话失败:', error);
        }
    }
}

async function loadSession() {
    if (fs.existsSync(sessionFilePath)) {
        try {
            const sessionData = await fs.readJson(sessionFilePath);
            logWithFlush('[会话] 会话已加载');
            return sessionData;
        } catch (error) {
            logErrorWithFlush('[会话] 加载会话失败:', error);
            // 如果加载失败，删除文件，确保下次是干净的开始
            await fs.remove(sessionFilePath).catch(() => {});
            return null;
        }
    }
    return null;
}

async function clearSession() {
    try {
        if (fs.existsSync(sessionFilePath)) {
            await fs.remove(sessionFilePath);
            logWithFlush('[会话] 会话已清除');
        }
        isLoggedIn = false;
        if (context) {
            await context.close().catch(() => {});
            context = null;
        }
        if (browser) {
            await browser.close().catch(() => {});
            browser = null;
        }
        loginPage = null; // 清除登录页面实例
    } catch (error) {
        logErrorWithFlush('[会话] 清除会话失败:', error);
        throw error;
    }
}

// 初始化浏览器和上下文
async function initBrowser() {
    try {
        if (!browser || !browser.isConnected()) { // 检查浏览器实例是否存在且已连接
            logWithFlush('[浏览器] 启动浏览器...');
            browser = await chromium.launch({
                headless: true,
                args: [
                    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                    '--disable-web-security', '--disable-features=VizDisplayCompositor',
                    '--disable-gpu', '--disable-extensions', '--no-first-run', '--disable-default-apps',
                    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding', '--memory-pressure-off',
                    '--max_old_space_size=384', '--disable-background-networking',
                    '--disable-ipc-flooding-protection', '--disable-features=Translate,BackForwardCache,AcceptCHFrame,VizDisplayCompositor',
                    '--disable-hang-monitor', '--disable-prompt-on-repost', '--disable-domain-reliability'
                ]
            });
        }

        // CHANGE: 仅在 context 不存在 或 浏览器连接断开时才重建上下文
        // 移除了 context.pages().length === 0 的判断，因为页面关闭是正常操作
        if (!context || !browser.isConnected()) {
            logWithFlush('[浏览器] 创建或重建浏览器上下文...');
            const sessionData = await loadSession();
            const contextOptions = {
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            };
            if (sessionData) {
                contextOptions.storageState = sessionData;
            }
            context = await browser.newContext(contextOptions);
            // 确保登录状态基于会话数据更新
            isLoggedIn = sessionData ? true : false;
        }

        logWithFlush('[浏览器] 浏览器和上下文初始化完成');
    } catch (error) {
        logErrorWithFlush('[浏览器] 浏览器初始化失败:', error);
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        context = null;
        browser = null;
        loginPage = null;
        isLoggedIn = false; // 确保失败时登录状态为false
        throw error;
    }
}


// 检查登录状态
async function checkLoginStatus() {
    const maxRetries = 2;
    let lastError;

    for (let i = 0; i < maxRetries; i++) {
        let page = null;
        try {
            logWithFlush(`[登录检查] 检查登录状态 (尝试 ${i + 1}/${maxRetries})`);
            await initBrowser(); // 确保浏览器和上下文已初始化

            page = await context.newPage();
            await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 20000 });

            // 检查是否存在登录相关的元素（例如登录按钮、登录二维码等），或者不存在已登录用户的元素
            const loginButtonVisible = await page.waitForSelector('a[action-type="login"]', { state: 'visible', timeout: 3000 }).catch(() => null);
            const postButtonVisible = await page.waitForSelector('button[title="发微博"]', { state: 'visible', timeout: 3000 }).catch(() => null);

            if (postButtonVisible) {
                isLoggedIn = true;
                logWithFlush('[登录检查] ✅ 用户已登录');
                return true;
            } else if (loginButtonVisible) {
                isLoggedIn = false;
                logWithFlush('[登录检查] ❌ 用户未登录 (检测到登录按钮)');
                return false;
            } else {
                // 如果既没有发微博按钮也没有登录按钮，可能需要更深入的检查
                // 例如，检查是否存在用户头像或昵称等元素
                const userInfoVisible = await page.waitForSelector('.gn_name', { state: 'visible', timeout: 3000 }).catch(() => null);
                if (userInfoVisible) {
                     isLoggedIn = true;
                     logWithFlush('[登录检查] ✅ 用户已登录 (检测到用户信息)');
                     return true;
                } else {
                     isLoggedIn = false;
                     logWithFlush('[登录检查] ❌ 用户未登录 (未检测到明确的登录或未登录状态，可能是需要登录)');
                     return false;
                }
            }
        } catch (error) {
            lastError = error;
            logErrorWithFlush(`[登录检查] 登录状态检查失败 (尝试 ${i + 1}):`, error.message);
            isLoggedIn = false; // 检查失败也视为未登录
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
    throw lastError || new Error('检查登录状态失败');
}

// 获取登录二维码
app.get('/api/qrcode', async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${AUTH_TOKEN}`) {
        return res.status(401).json({ error: '未经授权' });
    }

    try {
        await initBrowser();
        await checkLoginStatus(); // 先检查一次登录状态

        if (isLoggedIn) {
            logWithFlush('[二维码] 用户已登录，无需二维码。');
            return res.json({ qrcode: null, message: '用户已登录', isLoggedIn: true });
        }

        if (!loginPage) {
            logWithFlush('[二维码] 创建新的登录页面...');
            loginPage = await context.newPage();
            // 设置一个更长的默认超时时间
            loginPage.setDefaultTimeout(30000);
        }

        logWithFlush('[二维码] 导航到登录页...');
        await loginPage.goto('https://weibo.com', { waitUntil: 'domcontentloaded' });
        logWithFlush('[二维码] 等待二维码元素出现...');

        // 尝试点击切换到二维码登录模式，如果需要
        const qrcodeLoginTab = await loginPage.waitForSelector('.tab_q_code', { state: 'visible', timeout: 5000 }).catch(() => null);
        if (qrcodeLoginTab) {
            await qrcodeLoginTab.click();
            logWithFlush('[二维码] 已切换到二维码登录TAB');
        }

        const qrcodeSelector = '.qrcode_image img';
        await loginPage.waitForSelector(qrcodeSelector, { state: 'visible', timeout: 10000 });
        const qrcodeElement = await loginPage.$(qrcodeSelector);

        if (!qrcodeElement) {
            throw new Error('未找到二维码图片元素');
        }

        const qrcodeBase64 = await qrcodeElement.evaluate(img => {
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            return canvas.toDataURL();
        });

        logWithFlush('[二维码] 成功获取二维码');
        res.json({ qrcode: qrcodeBase64, message: '请扫描二维码登录', isLoggedIn: false });

        // 开始轮询检查登录状态，但不阻塞当前请求
        // 确保不会创建重复的监听器
        if (!loginPage.listenerCount('close')) {
            loginPage.on('close', () => {
                logWithFlush('[二维码] 登录页面已关闭。');
                loginPage = null; // 清除引用
            });
        }
        
        // 启动一个后台任务来轮询登录状态，直到登录成功或二维码失效
        (async () => {
            const pollInterval = 3000; // 轮询间隔
            const maxPollDuration = 5 * 60 * 1000; // 最长轮询时间
            const startTime = Date.now();
            logWithFlush('[二维码] 开始后台轮询登录状态...');

            while (Date.now() - startTime < maxPollDuration && !isLoggedIn) {
                await new Promise(resolve => setTimeout(resolve, pollInterval));
                try {
                    // 检查页面是否还存在二维码元素，如果不存在了可能已经跳转或过期
                    const currentQrcode = await loginPage.$(qrcodeSelector);
                    if (!currentQrcode && !isLoggedIn) { // 如果二维码消失且未登录，则二维码可能已失效
                         logWithFlush('[二维码] 二维码可能已失效或页面已跳转。');
                         break; // 退出轮询
                    }
                    await loginPage.reload({ waitUntil: 'domcontentloaded' }).catch(e => {
                        logErrorWithFlush('[二维码] 轮询时页面重载失败:', e.message);
                        // 如果重载失败，页面可能已关闭，退出轮询
                        return;
                    });
                    await checkLoginStatus(); // 再次检查登录状态
                    if (isLoggedIn) {
                        logWithFlush('[二维码] 轮询检测到用户已登录。');
                        await saveSession(); // 登录成功后保存会话
                        if (loginPage) { // 确保页面存在
                            await loginPage.close().catch(e => logErrorWithFlush('[二维码] 关闭登录页面失败:', e.message));
                            loginPage = null;
                        }
                        break; // 登录成功，退出轮询
                    }
                } catch (error) {
                    logErrorWithFlush('[二维码] 轮询登录状态时出错:', error.message);
                    // 如果页面已关闭，也停止轮询
                    if (error.message.includes('Page closed')) {
                        logWithFlush('[二维码] 轮询期间页面已关闭，停止轮询。');
                        break;
                    }
                }
            }
            logWithFlush('[二维码] 轮询登录状态结束。');
            // 如果轮询结束但仍未登录，则确保loginPage被关闭
            if (!isLoggedIn && loginPage) {
                 await loginPage.close().catch(e => logErrorWithFlush('[二维码] 轮询结束但未登录，关闭登录页面失败:', e.message));
                 loginPage = null;
            }
        })();

    } catch (error) {
        logErrorWithFlush('[二维码] 获取二维码失败:', error);
        isLoggedIn = false; // 失败时确保登录状态为false
        if (loginPage) { // 如果失败，关闭可能打开的登录页面
            await loginPage.close().catch(e => logErrorWithFlush('[二维码] 错误时关闭登录页面失败:', e.message));
            loginPage = null;
        }
        res.status(500).json({ error: '获取二维码失败', details: error.message });
    }
});

// 发布微博
app.post('/api/post', async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${AUTH_TOKEN}`) {
        return res.status(401).json({ error: '未经授权' });
    }

    const { content } = req.body;

    if (!content || typeof content !== 'string' || content.trim() === '') {
        return res.status(400).json({ error: '微博内容不能为空且为字符串' });
    }

    if (content.length > 140) {
        return res.status(400).json({ error: '微博内容不能超过140字' });
    }

    let page = null;
    try {
        logWithFlush('[发微博] 尝试发布微博...');
        await initBrowser(); // 确保浏览器和上下文已初始化
        await checkLoginStatus(); // 检查登录状态

        if (!isLoggedIn) {
            logWithFlush('[发微博] 用户未登录，无法发布微博。');
            return res.status(403).json({ error: '用户未登录，请先登录' });
        }

        page = await context.newPage();
        await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded', timeout: 20000 });

        // 等待发布按钮出现
        const postButtonSelector = 'button[title="发微博"]';
        await page.waitForSelector(postButtonSelector, { state: 'visible', timeout: 10000 });
        await page.click(postButtonSelector);

        // 等待文本输入框出现
        const textareaSelector = '.Form_input_cdY3C'; // 微博发布框的通用选择器
        await page.waitForSelector(textareaSelector, { state: 'visible', timeout: 5000 });
        await page.fill(textareaSelector, content);

        // 点击发送按钮
        const sendButtonSelector = '.Form_btn_YhGzO.woo-button-main'; // 发布框中的发送按钮
        await page.waitForSelector(sendButtonSelector, { state: 'visible', timeout: 5000 });
        await page.click(sendButtonSelector);

        // 等待发布成功提示或页面跳转
        // 可以根据实际情况等待微博发布成功的提示或者页面是否刷新
        // 这里简单等待几秒钟，或者可以尝试检测微博是否出现在个人主页
        logWithFlush('[发微博] 微博已发送，等待结果...');
        await page.waitForTimeout(3000); // 等待3秒钟，让微博发布完成并页面更新

        // 进一步检查是否发布成功 (可选)
        // 例如，可以导航到用户主页并检查最新的微博
        // 但为了简洁和降低复杂性，此处暂不实现详细的发布成功验证
        // 我们可以假设点击发送按钮后，如果前面没有报错，则成功

        logWithFlush('[发微博] 微博发布成功');
        res.json({ message: '微博发布成功' });

    } catch (error) {
        logErrorWithFlush('[发微博] 发布微博失败:', error);
        res.status(500).json({ error: '发布微博失败', details: error.message });
    } finally {
        if (page) {
            await page.close().catch(e => logErrorWithFlush('[发微博] 关闭页面失败:', e.message));
        }
    }
});

// 获取登录状态
app.get('/api/status', async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${AUTH_TOKEN}`) {
        return res.status(401).json({ error: '未经授权' });
    }
    try {
        await checkLoginStatus();
        res.json({ isLoggedIn: isLoggedIn });
    } catch (error) {
        logErrorWithFlush('[状态] 获取登录状态失败:', error);
        res.status(500).json({ error: '获取登录状态失败', details: error.message });
    }
});

// 清除会话
app.post('/api/clear-session', async (req, res) => {
    if (req.headers['authorization'] !== `Bearer ${AUTH_TOKEN}`) {
        return res.status(401).json({ error: '未经授权' });
    }
    try {
        await clearSession();
        logWithFlush('[清除会话] 会话已成功清除。');
        res.json({ message: '会话已清除' });
    } catch (error) {
        logErrorWithFlush('[清除会话] 清除会话失败:', error);
        res.status(500).json({ error: '清除会话失败', details: error.message });
    }
});

// 健康检查接口
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
    logErrorWithFlush('[错误] 未处理的 Promise 拒绝:', reason, promise);
});

process.on('uncaughtException', (err) => {
    logErrorWithFlush('[错误] 未捕获的异常:', err);
    process.exit(1); // 紧急退出
});

// 启动服务器
app.listen(PORT, () => {
    logWithFlush(`服务器正在监听端口 ${PORT}`);
    initBrowser().catch(error => {
        logErrorWithFlush('初始化浏览器失败，服务器可能无法正常工作:', error);
    });
});
