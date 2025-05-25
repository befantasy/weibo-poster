require('dotenv').config(); // 加载 .env 文件
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'weibo-proxy'; // 鉴权 token
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');
const { chromium } = require('playwright');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(bodyParser.json());
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

// 初始化浏览器
async function initBrowser() {
    if (!browser) {
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-web-security',
                '--disable-features=VizDisplayCompositor'
            ]
        });
    }
    
    if (!context) {
        // 尝试恢复会话
        const sessionData = await loadSession();
        if (sessionData) {
            context = await browser.newContext({
                storageState: sessionData
            });
        } else {
            context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });
        }
    }
    
    if (!page) {
        page = await context.newPage();
    }
}

// 保存会话
async function saveSession() {
    if (context) {
        const sessionData = await context.storageState();
        await fs.writeJson(SESSION_FILE, sessionData);
        console.log('会话已保存');
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

// 检查登录状态
async function checkLoginStatus() {
    try {
        await initBrowser();
        await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded' });
        
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
        console.error('检查登录状态失败:', error);
        isLoggedIn = false;
        return false;
    }
}

// 获取二维码
async function getQRCode() {
    try {
        await initBrowser();
        await page.goto('https://passport.weibo.com/sso/signin?entry=miniblog&source=miniblog', {
            waitUntil: 'networkidle'
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
        console.error('获取二维码失败:', error);
        throw error;
    }
}

// 检查扫码状态
async function checkScanStatus() {
    try {
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
        return { status: 'error', message: '检查状态失败' };
    }
}


// 发送微博
async function postWeibo(content) {
    try {
        if (!isLoggedIn) {
            throw new Error('用户未登录');
        }

        await initBrowser();
        await page.goto('https://weibo.com', { waitUntil: 'domcontentloaded' });

        // 等待发布框加载
        await page.waitForSelector('textarea[placeholder="有什么新鲜事想分享给大家？"]');

        // 输入内容
        await page.fill('textarea[placeholder="有什么新鲜事想分享给大家？"]', content);

        // 等待按钮可用（从 disabled 变成 enabled）
        await page.waitForSelector('button:has-text("发送"):not([disabled])', { timeout: 10000 });

        // === 监听发布接口响应 ===
        const [response] = await Promise.all([
            page.waitForResponse(response =>
                response.url().includes('/ajax/statuses/update') &&
                response.status() === 200
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
                content: result.data?.text_raw || '',
            };
        } else {
            throw new Error(`微博接口返回失败: ${result.msg || '未知错误'}`);
        }

    } catch (error) {
        console.error('发送微博失败:', error);
        throw error;
    }
}


// API路由

// 检查登录状态
app.get('/api/status', async (req, res) => {
    try {
        const loginStatus = await checkLoginStatus();
        res.json({ isLoggedIn: loginStatus });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 获取二维码
app.get('/api/qrcode', async (req, res) => {
    try {
        const qrCodeUrl = await getQRCode();
        res.json({ qrCodeUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 检查扫码状态
app.get('/api/scan-status', async (req, res) => {
    try {
        const status = await checkScanStatus();
        res.json(status);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 发送微博
app.post('/api/post', async (req, res) => {
    try {
        const { content } = req.body;
        if (!content) {
            return res.status(400).json({ error: '内容不能为空' });
        }
        
        const result = await postWeibo(content);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 退出登录
app.post('/api/logout', async (req, res) => {
    try {
        // 删除会话文件
        if (await fs.pathExists(SESSION_FILE)) {
            await fs.remove(SESSION_FILE);
        }
        
        // 重置状态
        isLoggedIn = false;
        
        // 关闭浏览器上下文
        if (context) {
            await context.close();
            context = null;
            page = null;
        }
        
        res.json({ success: true, message: '退出登录成功' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 服务器关闭时清理资源
process.on('SIGINT', async () => {
    console.log('正在关闭服务器...');
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('正在关闭服务器...');
    if (browser) {
        await browser.close();
    }
    process.exit(0);
});

app.listen(PORT, () => {
    console.log(`服务器运行在端口 ${PORT}`);
    console.log(`访问地址: http://localhost:${PORT}`);
});
