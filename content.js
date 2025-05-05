// content.js
// Chrome 扩展内容脚本，用于在 Twitter/X 推文详情页添加 AI 自动回复功能

// 常量定义
const SELECTORS = {
    ARTICLE: 'article[tabindex="-1"]', // 当前需要回复的推文整个块元素
    USERNAME: 'div[data-testid="User-Name"]',
    TWEET_NORMAL: 'div[data-testid="tweetText"]',  //推文详情
    TWEET_ARTICLE: 'div[data-testid="twitterArticleReadView"]',  //文章类型的推文详情
    REPLY_BUTTON: 'button[data-testid="tweetButtonInline"]',
    REPLY_TEXTAREA: 'div[data-testid="inline_reply_offscreen"]',
    TEXTBOX: 'div[role="textbox"][contenteditable="true"]',
};

// 新增：回复风格选项
const REPLY_STYLES = [
    { id: 'agree', label: '表示赞同', prompt: '以友好、积极的语气表示赞同，评论简洁且不超过30字，无特殊字符。' },
    { id: 'disagree', label: '表示反对', prompt: '以礼貌、建设性的语气表示反对，评论简洁且不超过30字，无特殊字符。' },
    { id: 'humorous', label: '幽默回复', prompt: '以幽默、友好的语气回复，评论简洁且不超过30字，无特殊字符。' },
    { id: 'collaboration', label: '寻求合作', prompt: '以专业、热情的语气寻求合作机会，评论简洁且不超过30字，无特殊字符。' },
    { id: 'share_opinion', label: '分享观点', prompt: '以中立、清晰的语气分享个人观点，评论简洁且不超过30字，无特殊字符。' }
];

const CONFIG = {
    MAX_ATTEMPTS: 20,  //最大重试次数
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
    warn: (...args) => console.log('[Lanniao Extension]', ...args),
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
        const articleElements = document.querySelectorAll(SELECTORS.ARTICLE);
        if (!articleElements.length) {
            logger.error('No article elements found');
            return null;
        }

        const tweetNormalElement = articleElements[0].querySelector(SELECTORS.TWEET_NORMAL); // 优先取普通推文
        const tweetArticleElement = articleElements[0].querySelector(SELECTORS.TWEET_ARTICLE); // 优先取普通推文
        if(tweetNormalElement){
            const content = tweetNormalElement?.innerText;
            return {content};
        }else if (tweetArticleElement){
            const content = tweetArticleElement?.innerText;
            return {content};
        }else{
            const content = "无内容";
            logger.error('Failed to extract content return default no content');
            return {content};
        }
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

// 创建多选列表
function createStyleSelector(aiButton, onSelect) {
    // 移除已有的选择器（避免重复）
    const existingSelector = document.querySelector('.style-selector');
    if (existingSelector) existingSelector.remove();

    const selector = document.createElement('div');
    selector.className = 'style-selector';
    selector.style.position = 'absolute';
    selector.style.backgroundColor = '#fff';
    selector.style.border = '1px solid #ccc';
    selector.style.borderRadius = '4px';
    selector.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
    selector.style.zIndex = '9999';
    selector.style.padding = '10px';
    selector.style.minWidth = '150px';

    // 计算位置（显示在按钮下方）
    const rect = aiButton.getBoundingClientRect();
    selector.style.top = `${rect.bottom + window.scrollY + 5}px`;
    selector.style.left = `${rect.left + window.scrollX}px`;

    // 添加选项
    REPLY_STYLES.forEach(style => {
        const option = document.createElement('div');
        option.style.padding = '8px';
        option.style.cursor = 'pointer';
        option.style.color = '#000';
        option.style.fontSize = '14px';
        option.textContent = style.label;
        option.addEventListener('click', () => {
            onSelect(style);
            selector.remove();
        });
        option.addEventListener('mouseover', () => {
            option.style.backgroundColor = '#f0f0f0';
        });
        option.addEventListener('mouseout', () => {
            option.style.backgroundColor = '#fff';
        });
        selector.appendChild(option);
    });

    document.body.appendChild(selector);

    // 点击其他地方关闭
    const closeSelector = (event) => {
        if (!selector.contains(event.target) && event.target !== aiButton) {
            selector.remove();
            document.removeEventListener('click', closeSelector);
        }
    };
    setTimeout(() => {
        document.addEventListener('click', closeSelector);
    }, 0);

    return selector;
}

// 修改：创建 AI 回复按钮
function createAIButton(replyButton) {
    if (state.aiButton) {
        return state.aiButton;
    }

    const aiButton = replyButton.cloneNode(true);
    aiButton.classList.add('ai-reply-button');
    aiButton.setAttribute('data-testid', 'aiReplyButton');
    aiButton.disabled = false;
    aiButton.removeAttribute('disabled');

    const textSpan = aiButton.querySelector('span span') || aiButton.querySelector('span') || aiButton;
    textSpan.innerText = 'AI';

    aiButton.style.backgroundColor = '#1DA1F2';
    aiButton.style.color = '#fff';
    aiButton.style.opacity = '1';
    aiButton.style.marginRight = '10px';

    aiButton.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        // 显示风格选择器
        createStyleSelector(aiButton, async (selectedStyle) => {
            try {
                aiButton.disabled = true;
                textSpan.innerText = '生成中';

                const tweet = extractTweet();
                if (!tweet) throw new Error('Unable to extract tweet');

                const messages = [
                    {
                        role: 'user',
                        content: `你是一个推特用户，请对以下推文内容发表评论[${tweet.content}] 要求：1. ${selectedStyle.prompt} 2. 如果推文内容为空，生成简短的友好评论。3. 不得包含敏感或违规内容，不要有任何特殊字符，或者符号 4. 只输出评论内容。`
                    }
                ];

                const response = await new Promise((resolve, reject) => {
                    chrome.runtime.sendMessage({ action: 'requestOpenAI', messages }, (resp) => {
                        if (resp.success) resolve(resp);
                        else reject(new Error(resp.error || 'OpenAI request failed'));
                    });
                });

                const replyContent = response.reply.replace(/[\r\n]+/g, '');
                logger.info('OpenAI reply:', replyContent);

                const truncatedReply = replyContent.slice(0, CONFIG.MAX_AI_REPLY_LIMIT);
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
            const aiButton = createAIButton(replyButton);
            replyButton.parentNode.insertBefore(aiButton, replyButton);
            //logger.info('AI button inserted');
            break;

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
        if(replyTextArea) {
            replyTextArea.removeEventListener('click', insertAutoReplyButton);
            replyTextArea.addEventListener('click', insertAutoReplyButton);
            logger.info('Reply textarea listener added');
        }
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