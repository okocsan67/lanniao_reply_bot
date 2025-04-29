// content.js
// Chrome 扩展内容脚本，用于在 Twitter/X 推文详情页添加 AI 自动回复功能

// 常量定义
const SELECTORS = {
    TWEET: 'article[tabindex="-1"], article', // 推文元素（优先详情页，降级到普通推文）
    USERNAME: 'div[data-testid="User-Name"]',
    TWEET_TEXT: 'div[data-testid="tweetText"], div[data-testid="twitterArticleReadView"]',  //优先获取推文，然后获取文章
    REPLY_BUTTON: 'button[data-testid="tweetButtonInline"]',
    REPLY_TEXTAREA: 'div[data-testid="inline_reply_offscreen"]',
    TEXTBOX: 'div[role="textbox"][contenteditable="true"]',
};

const CONFIG = {
    MAX_ATTEMPTS: 10,  //最大重试次数
    POLL_INTERVAL_MS: 200,  //默认重试间隔
    MAX_AI_REPLY_LIMIT: 100,  //最多输入多少个字的回复
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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


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

        return {username, content};
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
                    editor.dispatchEvent(new Event('input', {bubbles: true}));

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
                    content: `你是一个推特用户，请对以下推文内容发表评论：${tweet.content}。要求：1. 评论必须严格限制在30个字以内，不要出现特殊字符。2. 评论以赞同为主，语气友好且积极。3. 不得包含敏感或违规内容。4. 只输出评论内容，不包含任何解释或其他文字。5. 如果推文内容相同，每次生成不同的评论  
                            `,
                },
            ];

            const response = await new Promise((resolve, reject) => {
                chrome.runtime.sendMessage({action: 'requestOpenAI', messages}, (resp) => {
                    if (resp.success) resolve(resp);
                    else reject(new Error(resp.error || 'OpenAI request failed'));
                });
            });

            const replyContent = response.reply.replace(/[\r\n]+/g, '');
            logger.info('OpenAI reply:', replyContent);

            //最多保留100个字符 有时候AI会抽风开始长篇大论
            const truncatedReply = replyContent.slice(0, 100);
            logger.info('after truncatedReply:', truncatedReply);

            await simulateTyping(truncatedReply);
            logger.info('AI reply inserted');

            aiButton.disabled = false;
            textSpan.innerText = 'AI';
        } catch (error) {
            logger.error('AI button click failed:', error.message);
            showUserError('Failed to generate reply. Please try again.');
            aiButton.disabled = false;
            textSpan.innerText = 'AI';
        }
    });

    state.aiButton = aiButton;
    return aiButton;
}

// 插入 AI 按钮
async function insertAutoReplyButton() {

    let attempt = 0;
    while (attempt < CONFIG.MAX_ATTEMPTS) {
        try {
            attempt++;
            await sleep(200);
            const replyButton = await waitForElement(SELECTORS.REPLY_BUTTON);
            if (!document.querySelector('.ai-reply-button')) {
                const aiButton = createAIButton(replyButton);
                replyButton.parentNode.insertBefore(aiButton, replyButton);
                logger.info('AI button inserted');
            }
        } catch (error) {
            if (attempt >= CONFIG.MAX_ATTEMPTS) {
                logger.error('Failed to insert AI button:', error.message);
                showUserError('无法插入 AI 按钮，请稍后重试');
                break; // 达到最大重试次数后退出循环
            }
        }
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
        sendResponse({status: 'success'});
    }
});

// 初始化
initPage().then(() => {
    chrome.runtime.sendMessage({action: 'lanniaoContentScriptLoaded'});
});