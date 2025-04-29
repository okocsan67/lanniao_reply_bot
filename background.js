// background.js
// Chrome 扩展后台脚本，处理 OpenAI API 请求和页面初始化

// 日志工具
const logger = {
    info: (...args) => console.log('[Lanniao Extension]', ...args),
    error: (...args) => console.error('[Lanniao Extension]', ...args),
};


// 缓存 API 密钥到本地
let cachedApiKey = null;
async function getApiKey() {
    if (cachedApiKey) return cachedApiKey;
    const result = await chrome.storage.local.get(['openaiApiKey']);
    cachedApiKey = result.openaiApiKey;
    return cachedApiKey;
}

// 监听存储变化
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.openaiApiKey) {
        cachedApiKey = changes.openaiApiKey.newValue;
        logger.info('OpenAI API key updated:', cachedApiKey ? 'set' : 'cleared');
    }
});

// 发送 OpenAI 请求
async function sendOpenAIRequest(messages) {
    const apiKey = await getApiKey();
    if (!apiKey) {
        throw new Error('OpenAI API key not set. Please configure in options page.');
    }

    try {
        const response = await fetch('https://api.gptapi.us/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages,
            }),
        });

        if (!response.ok) {
            throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        logger.info('OpenAI response:', data);
        return data.choices[0].message.content;
    } catch (error) {
        logger.error('OpenAI request failed:', error.message);
        throw error;
    }
}

// 消息处理
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender.tab || !sender.url.startsWith('https://x.com/')) {
        logger.error('Unauthorized message from:', sender.url);
        return;
      }

    if (message.action === 'requestOpenAI') {
        sendOpenAIRequest(message.messages)
            .then((reply) => sendResponse({ success: true, reply }))
            .catch((error) => sendResponse({ success: false, error: error.message }));
        return true; // 异步响应
    }

    if (message.action === 'lanniaoContentScriptLoaded') {
        logger.info(`Content script loaded for tab ${sender.tab.id}`);
        // 初始化页面（仅在详情页）
        const url = sender.tab.url;
        if (url && /^https:\/\/x\.com\/[^/]+\/status\/\d+$/.test(url)) {
            chrome.tabs.sendMessage(sender.tab.id, { action: 'initPage' }, (response) => {
                if (chrome.runtime.lastError) {
                    logger.error('Error sending initPage message:', chrome.runtime.lastError.message);
                } else {
                    logger.info('initPage message sent:', response);
                }
            });
        }
    }
});

// 监听标签更新
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && /^https:\/\/x\.com\/[^/]+\/status\/\d+$/.test(changeInfo.url)) {
        chrome.tabs.sendMessage(tabId, { action: 'initPage' }, (response) => {
            if (chrome.runtime.lastError) {
                logger.error('Error sending initPage message:', chrome.runtime.lastError.message);
            } else {
                logger.info('initPage message sent:', response);
            }
        });
    }
});

// 扩展安装/更新处理
chrome.runtime.onInstalled.addListener((details) => {
    logger.info('Extension installed/updated:', details.reason);
    if (details.reason === 'install') {
        chrome.runtime.openOptionsPage();
    }
});