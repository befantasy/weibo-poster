const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { chromium } = require('playwright');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// 简单的内存存储 (生产环境建议使用 Redis)
const storage = new Map();

// 路由
app.get('/', (req, res) => {
  res.send(getLoginPage());
});

app.get('/qr', async (req, res) => {
  try {
    const result = await getQRCode();
    res.send(result);
  } catch (error) {
    res.status(500).send(`获取二维码失败: ${error.message}`);
  }
});

app.get('/check', async (req, res) => {
  try {
    const sessionId = req.query.session;
    const result = await checkLogin(sessionId);
    res.send(result);
  } catch (error) {
    res.status(500).send(`检查失败: ${error.message}`);
  }
});

app.post('/post', async (req, res) => {
  try {
    const { content, sessionId } = req.body;
    const result = await postWeibo(content, sessionId);
    res.send(result);
  } catch (error) {
    res.status(500).send(`发布失败: ${error.message}`);
  }
});

// 获取二维码
async function getQRCode() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  });
  
  const page = await browser.newPage();

  try {
    // 访问微博登录页面
    await page.goto('https://weibo.com/login.php', { 
      waitUntil: 'networkidle',
      timeout: 30000 
    });
    
    await page.waitForTimeout(3000);

    // 点击二维码登录选项卡
    try {
      const qrTab = page.locator('.info_list .login_tab a').filter({ hasText: '扫码登录' });
      if (await qrTab.isVisible({ timeout: 5000 })) {
        await qrTab.click();
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      console.log('未找到扫码登录选项卡，继续寻找二维码');
    }

    // 查找二维码图片
    const qrSelectors = [
      '.qrcode_img img',
      '.login_qrcode img',
      '.code_box img',
      'img[src*="qr.weibo.cn"]',
      'img[src*="qrcode"]',
      '.qr_code img'
    ];

    let qrSrc = null;
    
    for (const selector of qrSelectors) {
      try {
        const elements = await page.locator(selector).all();
        
        for (const element of elements) {
          if (await element.isVisible({ timeout: 2000 })) {
            const src = await element.getAttribute('src');
            if (src && (src.includes('qr') || src.includes('login'))) {
              qrSrc = src;
              break;
            }
          }
        }
        
        if (qrSrc) break;
      } catch (e) {
        continue;
      }
    }

    if (!qrSrc) {
      // 如果没有找到二维码，尝试强制刷新或点击二维码按钮
      try {
        const qrButton = page.locator('a[href*="qr"], .qr_btn, [node-type="qrcodeLogin"]');
        if (await qrButton.isVisible({ timeout: 3000 })) {
          await qrButton.click();
          await page.waitForTimeout(3000);
          
          // 重新查找二维码
          for (const selector of qrSelectors) {
            try {
              const element = page.locator(selector);
              if (await element.isVisible({ timeout: 2000 })) {
                qrSrc = await element.getAttribute('src');
                if (qrSrc) break;
              }
            } catch (e) {
              continue;
            }
          }
        }
      } catch (e) {
        console.log('尝试点击二维码按钮失败');
      }
    }

    let sessionId = `qr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    if (qrSrc) {
      // 确保二维码URL是完整的
      if (qrSrc.startsWith('//')) {
        qrSrc = 'https:' + qrSrc;
      } else if (qrSrc.startsWith('/')) {
        qrSrc = 'https://weibo.com' + qrSrc;
      }

      // 提取二维码ID
      let qrId = null;
      try {
        const qrUrl = new URL(qrSrc);
        qrId = qrUrl.searchParams.get('qrid') || qrUrl.searchParams.get('id') || qrUrl.pathname.split('/').pop();
      } catch (e) {
        console.log('提取二维码ID失败:', e);
      }

      // 保存会话信息到内存
      storage.set(`session:${sessionId}`, {
        sessionId,
        createTime: Date.now(),
        status: 'waiting',
        qrSrc: qrSrc,
        qrId: qrId,
        pageUrl: page.url(),
        cookies: await page.context().cookies()
      });

      // 设置5分钟后自动清理
      setTimeout(() => {
        storage.delete(`session:${sessionId}`);
      }, 300000);

      const html = `
        <div style="text-align: center;">
          <img src="${qrSrc}" alt="二维码" style="max-width: 300px; border: 1px solid #ddd;">
          <input type="hidden" id="sessionId" value="${sessionId}">
          <script>
            window.sessionId = '${sessionId}';
            window.qrId = '${qrId || ''}';
          </script>
          <p style="margin-top: 10px; font-size: 12px; color: #666;">请使用微博APP扫描二维码</p>
        </div>
      `;

      await browser.close();
      return html;
    }
    
    // 调试信息
    const screenshot = await page.screenshot({ fullPage: false });
    const base64 = screenshot.toString('base64');
    
    await browser.close();
    
    const debugHtml = `
      <div style="text-align: center;">
        <h3>调试信息</h3>
        <p>当前URL: ${page.url()}</p>
        <p>页面标题: ${await page.title()}</p>
        <img src="data:image/png;base64,${base64}" alt="页面截图" style="max-width: 100%; border: 1px solid #ccc;">
        <p style="color: red;">未找到二维码，请检查页面</p>
      </div>
    `;
    
    return debugHtml;

  } catch (error) {
    await browser.close();
    throw error;
  }
}

// 检查登录状态
async function checkLogin(sessionId) {
  if (!sessionId) {
    throw new Error('缺少会话ID');
  }

  const sessionInfo = storage.get(`session:${sessionId}`);
  if (!sessionInfo) {
    throw new Error('会话已过期');
  }

  // 检查会话是否超时（5分钟）
  if (Date.now() - sessionInfo.createTime > 300000) {
    throw new Error('二维码已过期');
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  });
  
  const page = await browser.newPage();

  try {
    // 恢复之前的cookies
    if (sessionInfo.cookies && sessionInfo.cookies.length > 0) {
      try {
        await page.context().addCookies(sessionInfo.cookies);
      } catch (e) {
        console.log('恢复cookies失败:', e);
      }
    }

    // 检查微博主页是否已登录
    await page.goto('https://weibo.com', { 
      waitUntil: 'networkidle',
      timeout: 15000 
    });
    await page.waitForTimeout(3000);

    // 检查登录状态的多种方式
    const loginChecks = [
      // 检查用户名显示
      async () => {
        const selectors = ['.gn_name', '.UserName', '.username', '[node-type="username"]'];
        for (const selector of selectors) {
          try {
            if (await page.locator(selector).isVisible({ timeout: 2000 })) {
              return true;
            }
          } catch (e) {
            continue;
          }
        }
        return false;
      },
      // 检查URL变化
      async () => {
        const currentUrl = page.url();
        return currentUrl.includes('/home') || 
               (currentUrl.includes('weibo.com') && !currentUrl.includes('login'));
      },
      // 检查头像或个人信息
      async () => {
        const selectors = ['.head_img', '.avatar', '.UserAvatar', '.gn_header'];
        for (const selector of selectors) {
          try {
            if (await page.locator(selector).isVisible({ timeout: 2000 })) {
              return true;
            }
          } catch (e) {
            continue;
          }
        }
        return false;
      },
      // 检查登录相关的cookie
      async () => {
        const cookies = await page.context().cookies();
        const loginCookies = cookies.filter(c => 
          c.name.includes('SUB') || 
          c.name.includes('SUBP') || 
          c.name.includes('login') ||
          c.name.includes('uid')
        );
        return loginCookies.length > 0;
      }
    ];

    let isLoggedIn = false;
    for (const check of loginChecks) {
      try {
        if (await check()) {
          isLoggedIn = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (isLoggedIn) {
      // 登录成功，保存登录信息
      const cookies = await page.context().cookies();
      const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

      storage.set(`login:${sessionId}`, {
        sessionId,
        cookies: cookieString,
        cookiesArray: cookies,
        loginTime: Date.now(),
        userAgent: await page.evaluate(() => navigator.userAgent),
        loginUrl: page.url()
      });

      // 7天后自动清理
      setTimeout(() => {
        storage.delete(`login:${sessionId}`);
      }, 86400 * 7 * 1000);

      // 更新会话状态
      storage.set(`session:${sessionId}`, {
        ...sessionInfo,
        status: 'success',
        loginTime: Date.now()
      });

      await browser.close();
      return '登录成功';
    }

    // 如果主页检查失败，尝试直接检查登录页面的状态
    try {
      await page.goto(sessionInfo.pageUrl || 'https://weibo.com/login.php', { 
        timeout: 10000 
      });
      await page.waitForTimeout(2000);

      // 检查二维码状态
      const qrStatusSelectors = [
        '.qr_success',
        '.qr_confirm', 
        '.scan_success',
        '.login_success',
        '[class*="success"]'
      ];

      for (const selector of qrStatusSelectors) {
        try {
          if (await page.locator(selector).isVisible({ timeout: 1000 })) {
            // 发现成功状态，等待页面跳转
            await page.waitForTimeout(3000);
            
            // 再次检查是否已跳转到主页
            if (page.url().includes('weibo.com') && !page.url().includes('login')) {
              const cookies = await page.context().cookies();
              const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

              storage.set(`login:${sessionId}`, {
                sessionId,
                cookies: cookieString,
                cookiesArray: cookies,
                loginTime: Date.now(),
                userAgent: await page.evaluate(() => navigator.userAgent)
              });

              await browser.close();
              return '登录成功';
            }
          }
        } catch (e) {
          continue;
        }
      }
    } catch (e) {
      console.log('检查登录页面状态失败:', e);
    }

    await browser.close();
    return '等待扫描...';

  } catch (error) {
    await browser.close();
    throw error;
  }
}

// 发布微博
async function postWeibo(content, sessionId) {
  if (!content || !sessionId) {
    throw new Error('缺少内容或会话ID');
  }

  const loginInfo = storage.get(`login:${sessionId}`);
  if (!loginInfo) {
    throw new Error('未登录，请先登录');
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  });
  
  const page = await browser.newPage();

  try {
    // 使用保存的cookies
    if (loginInfo.cookiesArray) {
      await page.context().addCookies(loginInfo.cookiesArray);
    } else {
      // 备用方案：解析cookie字符串
      const cookies = loginInfo.cookies.split('; ').map(cookie => {
        const [name, ...valueParts] = cookie.split('=');
        const value = valueParts.join('=');
        return { name, value, domain: '.weibo.com', path: '/' };
      });
      await page.context().addCookies(cookies);
    }
    
    await page.goto('https://weibo.com', { timeout: 15000 });
    await page.waitForTimeout(3000);

    // 检查登录状态
    const loginSelectors = ['.gn_name', '.UserName', '[node-type="username"]'];
    let isLoggedIn = false;
    
    for (const selector of loginSelectors) {
      try {
        if (await page.locator(selector).isVisible({ timeout: 2000 })) {
          isLoggedIn = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!isLoggedIn) {
      await browser.close();
      throw new Error('登录已过期，请重新登录');
    }

    // 查找发布框
    const textAreaSelectors = [
      'textarea[node-type="text"]',
      'textarea[placeholder*="有什么新鲜事"]',
      'textarea[placeholder*="分享新鲜事"]',
      '.WB_editor_iframe textarea',
      '.send_weibo textarea',
      'textarea[name="text"]',
      '.W_input[node-type="text"]'
    ];

    let textArea = null;
    for (const selector of textAreaSelectors) {
      try {
        const element = page.locator(selector);
        if (await element.isVisible({ timeout: 3000 })) {
          textArea = element;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!textArea) {
      await browser.close();
      throw new Error('未找到发布框，页面可能已更新');
    }

    await textArea.fill(content);
    await page.waitForTimeout(1000);

    // 查找发布按钮
    const submitSelectors = [
      'a[node-type="submit"]',
      '.W_btn_a[title*="发布"]',
      'button[title*="发布"]',
      '.send_btn',
      '.W_btn_a[action-type="submit"]',
      '.W_btn_a[title="发布"]'
    ];

    let submitBtn = null;
    for (const selector of submitSelectors) {
      try {
        const element = page.locator(selector);
        if (await element.isVisible({ timeout: 2000 })) {
          submitBtn = element;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!submitBtn) {
      await browser.close();
      throw new Error('未找到发布按钮');
    }

    await submitBtn.click();
    await page.waitForTimeout(3000);

    // 检查发布结果
    const successIndicators = [
      () => page.locator('.W_tips_success').isVisible({ timeout: 2000 }).catch(() => false),
      () => page.locator('.tips[node-type="success"]').isVisible({ timeout: 2000 }).catch(() => false),
      () => page.locator('.success').isVisible({ timeout: 2000 }).catch(() => false),
      () => {
        const currentUrl = page.url();
        return currentUrl.includes('/home') || currentUrl.includes('/u/');
      }
    ];

    let isSuccess = false;
    for (const check of successIndicators) {
      try {
        if (await check()) {
          isSuccess = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    await browser.close();
    
    if (isSuccess) {
      return '发布成功';
    } else {
      return '发布可能失败，请检查微博是否已发布';
    }

  } catch (error) {
    await browser.close();
    throw error;
  }
}

// 登录页面HTML
function getLoginPage() {
  return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>微博登录</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
        .container { text-align: center; }
        .qr-container { margin: 20px 0; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
        button { padding: 10px 20px; margin: 10px; background: #1da1f2; color: white; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #0d8bd9; }
        #qrCode { max-width: 300px; margin: 20px auto; }
        #status { margin: 10px 0; font-weight: bold; }
        .post-form { margin-top: 30px; padding: 20px; border: 1px solid #ddd; border-radius: 8px; display: none; }
        textarea { width: 100%; height: 100px; margin: 10px 0; padding: 10px; border: 1px solid #ddd; border-radius: 4px; }
        .debug { margin-top: 20px; padding: 10px; background: #f5f5f5; border-radius: 4px; font-size: 12px; text-align: left; }
    </style>
</head>
<body>
    <div class="container">
        <h1>微博自动登录与发布</h1>
        
        <div class="qr-container">
            <h3>扫码登录</h3>
            <button onclick="getQRCode()">获取二维码</button>
            <div id="qrCode"></div>
            <div id="status"></div>
        </div>

        <div id="postForm" class="post-form">
            <h3>发布微博</h3>
            <textarea id="content" placeholder="输入微博内容..."></textarea>
            <button onclick="postWeibo()">发布微博</button>
            <div id="postStatus"></div>
        </div>

        <div id="debug" class="debug" style="display: none;"></div>
    </div>

    <script>
        let sessionId = null;
        let checkInterval = null;
        let checkCount = 0;
        const maxChecks = 100;

        function log(message) {
            const debugDiv = document.getElementById('debug');
            debugDiv.style.display = 'block';
            debugDiv.innerHTML += new Date().toLocaleTimeString() + ': ' + message + '<br>';
            console.log(message);
        }

        async function getQRCode() {
            try {
                document.getElementById('status').textContent = '正在获取二维码...';
                log('开始获取二维码');
                
                const response = await fetch('/qr');
                const result = await response.text();
                
                log('服务器响应内容: ' + result.substring(0, 500) + '...');
                
                if (response.ok) {
                    document.getElementById('qrCode').innerHTML = result;
                    
                    // 提取sessionId
                    let extractedSessionId = null;
                    const sessionIdMatch = result.match(/window\\.sessionId\\s*=\\s*['"]([^'"]+)['"]/);
                    if (sessionIdMatch) {
                        extractedSessionId = sessionIdMatch[1];
                        log('提取到sessionId: ' + extractedSessionId);
                    }
                    
                    if (extractedSessionId) {
                        sessionId = extractedSessionId;
                        startChecking();
                    } else {
                        log('未能从响应中提取sessionId');
                    }
                } else {
                    document.getElementById('status').textContent = '获取二维码失败: ' + result;
                    log('获取二维码失败: ' + result);
                }
            } catch (error) {
                document.getElementById('status').textContent = '网络错误: ' + error.message;
                log('网络错误: ' + error.message);
            }
        }

        function startChecking() {
            document.getElementById('status').textContent = '请使用微博APP扫描二维码...';
            log('开始检查登录状态');
            checkCount = 0;
            checkInterval = setInterval(checkLoginStatus, 3000);
        }

        async function checkLoginStatus() {
            if (!sessionId) return;
            
            checkCount++;
            log(\`检查登录状态 (\${checkCount}/\${maxChecks})\`);
            
            if (checkCount > maxChecks) {
                clearInterval(checkInterval);
                document.getElementById('status').textContent = '检查超时，请重新获取二维码';
                log('检查超时');
                return;
            }
            
            try {
                const response = await fetch(\`/check?session=\${sessionId}\`);
                const result = await response.text();
                log('检查结果: ' + result);
                
                if (result.includes('登录成功')) {
                    clearInterval(checkInterval);
                    document.getElementById('status').textContent = '登录成功！';
                    document.getElementById('postForm').style.display = 'block';
                    log('登录成功，显示发布表单');
                } else if (result.includes('已过期') || result.includes('超时')) {
                    clearInterval(checkInterval);
                    document.getElementById('status').textContent = '二维码已过期，请重新获取';
                    log('二维码已过期');
                } else {
                    document.getElementById('status').textContent = \`等待扫描... (\${checkCount}/\${maxChecks})\`;
                }
            } catch (error) {
                log('检查登录状态失败: ' + error.message);
            }
        }

        async function postWeibo() {
            const content = document.getElementById('content').value.trim();
            if (!content) {
                alert('请输入微博内容');
                return;
            }

            try {
                document.getElementById('postStatus').textContent = '正在发布...';
                log('开始发布微博: ' + content);
                
                const response = await fetch('/post', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content, sessionId })
                });
                
                const result = await response.text();
                document.getElementById('postStatus').textContent = result;
                log('发布结果: ' + result);
                
                if (response.ok && result.includes('成功')) {
                    document.getElementById('content').value = '';
                }
            } catch (error) {
                document.getElementById('postStatus').textContent = '发布失败: ' + error.message;
                log('发布失败: ' + error.message);
            }
        }
    </script>
</body>
</html>`;
}

// 启动服务器
app.listen(PORT, '0.0.0.0', () => {
  console.log(`微博发布服务器运行在端口 ${PORT}`);
  console.log(`访问 http://localhost:${PORT} 开始使用`);
});

module.exports = app;
