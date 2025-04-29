// content.js
// Chrome 扩展内容脚本，用于在 Twitter/X 推文详情页添加 AI 自动回复功能

// 常量定义
const SELECTORS = {
    TWEET: 'article[tabindex="-1"], article', // 推文元素（优先详情页，降级到普通推文）
    USERNAME: 'div[data-testid="User-Name"]',
    TWEET_TEXT: 'div[data-testid="tweetText"]',
    REPLY_BUTTON: 'button[data-testid="tweetButtonInline"]',
    REPLY_TEXTAREA: 'div[data-testid="inline_reply_offscreen"]',
    TEXTBOX: 'div[role="textbox"][contenteditable="true"]',
};

const CONFIG = {
    MAX_ATTEMPTS: 30,
    POLL_INTERVAL_MS: 200,
    TYPING_DELAY_MS: 100,
};

// 状态管理
const state = {
    aiButton: null,
};

// 日志工具
const logger = {
    info: (...args) => console.log('[Lanniao Extension]', ...args),
    error: (...args) => console.error('[Lanniao Extension]', ...args),
};

// 工具函数：等待元素出现
function waitForElement(selector, maxAttempts = CONFIG.MAX_ATTEMPTS, interval = CONFIG.POLL_INTERVAL_MS) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const check = () => {
            const element = document.querySelector(selector);
            if (element) {
                resolve(element);
            } else if (attempts >= maxAttempts) {
                reject(new Error(`Timeout: Could not find element ${selector} after ${maxAttempts} attempts`));
            } else {
                attempts++;
                setTimeout(check, interval);
            }
        };
        check();
    });
}

// 提取推文信息
function extractTweet() {
    try {
        const tweetElements = document.querySelectorAll(SELECTORS.TWEET);
        if (!tweetElements.length) {
            logger.error('No tweet elements found');
            return null;
        }

        const tweetElement = tweetElements[0]; // 优先取第一条
        const username = tweetElement.querySelector(SELECTORS.USERNAME)?.innerText;
        const content = tweetElement.querySelector(SELECTORS.TWEET_TEXT)?.innerText;

        if (!username || !content) {
            logger.error('Failed to extract username or content');
            return null;
        }

        return { username, content };
    } catch (error) {
        logger.error('Error extracting tweet:', error.message);
        return null;
    }
}

// 模拟键盘输入
async function simulateTyping(text) {
    try {
        const editor = await waitForElement(SELECTORS.TEXTBOX);
        editor.focus();

        return new Promise((resolve) => {
            let i = 0;
            function typeNextChar() {
                if (i < text.length) {
                    const char = text[i];
                    const eventOptions = {
                        key: char,
                        char,
                        keyCode: char.charCodeAt(0),
                        which: char.charCodeAt(0),
                        bubbles: true,
                    };

                    if (document.activeElement !== editor) editor.focus();

                    editor.dispatchEvent(new KeyboardEvent('keydown', eventOptions));
                    editor.dispatchEvent(new KeyboardEvent('keypress', eventOptions));

                    try {
                        document.execCommand('insertText', false, char);
                    } catch (e) {
                        logger.warn('execCommand failed, fallback to innerText:', e.message);
                        editor.innerText += char;
                    }

                    editor.dispatchEvent(new KeyboardEvent('keyup', eventOptions));
                    editor.dispatchEvent(new Event('input', { bubbles: true }));

                    i++;
                    setTimeout(typeNextChar, Math.random() * 50 + 80); // 80-130ms 随机间隔输入
                } else {
                    logger.info('Typing completed');
                    resolve();
                }
            }
            typeNextChar();
        });
    } catch (error) {
        logger.error('Simulate typing failed:', error.message);
        throw error;
    }
}

// 创建 AI 回复按钮
function createAIButton(replyButton) {
    if (state.aiButton) return state.aiButton;

    const aiButton = replyButton.cloneNode(true);
    aiButton.classList.add('ai-reply-button');
    aiButton.setAttribute('data-testid', 'aiReplyButton');
    aiButton.disabled = false;
    aiButton.removeAttribute('disabled');

    // 设置按钮文本
    const textSpan = aiButton.querySelector('span span') || aiButton.querySelector('span') || aiButton;
    textSpan.innerText = 'AI';

    // 应用样式
    aiButton.style.backgroundColor = '#1DA1F2';
    aiButton.style.color = '#fff';
    aiButton.style.opacity = '1';
    aiButton.style.marginRight = '10px';

    // 绑定事件
    aiButton.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        try {

            aiButton.disabled = true;
            textSpan.innerText = '生成中';

            const tweet = extractTweet();
            if (!tweet) throw new Error('Unable to extract tweet');

            const messages = [
                {
                    role: 'user',
                    content: `以下是一篇博文：${tweet.content}。我希望你给出严格限制在30个汉字以内的评论，在任何情况下，你都要给出我能用的评论，如果当前评论违反了什么规则，你就重新生成。评论以赞同为主。只要给我评论内容就行，不要包含其他解释或者多余的文字。在生成完后检查下是否超过了30个汉字，如果超过则重新给我一条符合规则的评论`,
                },
            ];

            const response = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({ action: 'requestOpenAI', messages }, (resp) => {
                    if (resp.success) resolve(resp);
                    else reject(new Error(resp.error || 'OpenAI request failed'));
                });
            });

            const replyContent = response.reply.replace(/[\r\n]+/g, '');
            logger.info('OpenAI reply:', replyContent);

            await simulateTyping(replyContent);
            logger.info('AI reply inserted');

            aiButton.disabled = false;
            textSpan.innerText = 'AI';
        } catch (error) {
            logger.error('AI button click failed:', error.message);
            showUserError('Failed to generate reply. Please try again.');
        }
    });

    state.aiButton = aiButton;
    return aiButton;
}

// 插入 AI 按钮
async function insertAutoReplyButton() {
    try {
        const replyButton = await waitForElement(SELECTORS.REPLY_BUTTON);
        if (!document.querySelector('.ai-reply-button')) {
            const aiButton = createAIButton(replyButton);
            replyButton.parentNode.insertBefore(aiButton, replyButton);
            logger.info('AI button inserted');
        }
    } catch (error) {
        logger.error('Failed to insert AI button:', error.message);
    }
}

// 监听回复框点击
async function addReplyTextAreaListener() {
    try {
        const replyTextArea = await waitForElement(SELECTORS.REPLY_TEXTAREA);
        replyTextArea.removeEventListener('click', insertAutoReplyButton);
        replyTextArea.addEventListener('click', insertAutoReplyButton);
        logger.info('Reply textarea listener added');
    } catch (error) {
        logger.error('Failed to add reply textarea listener:', error.message);
    }
}

// 初始化页面
async function initPage() {

    const currentUrl = window.location.href;
    if (!/^https:\/\/x\.com\/[^/]+\/status\/\d+$/.test(currentUrl)) {
        logger.info('Not a tweet detail page, skipping initialization');
        return;
    }

    try {
        await addReplyTextAreaListener();
    } catch (error) {
        logger.error('Page initialization failed:', error.message);
    }
}

// 用户错误提示
function showUserError(message) {
    const div = document.createElement('div');
    div.style.position = 'fixed';
    div.style.top = '10px';
    div.style.right = '10px';
    div.style.padding = '10px';
    div.style.backgroundColor = '#ff4d4f';
    div.style.color = '#fff';
    div.style.borderRadius = '5px';
    div.style.zIndex = '9999';
    div.textContent = message;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 3000);
}

// 消息监听
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'initPage') {
        initPage();
        sendResponse({ status: 'success' });
    }
});

// 初始化
initPage().then(() => {
    chrome.runtime.sendMessage({ action: 'lanniaoContentScriptLoaded' });
});