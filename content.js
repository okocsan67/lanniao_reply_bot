const SELECTORS = {
    ARTICLE: 'article[tabindex="-1"]',
    USERNAME: 'div[data-testid="User-Name"]',
    TWEET_NORMAL: 'div[data-testid="tweetText"]',
    TWEET_ARTICLE: 'div[data-testid="twitterArticleReadView"]',
    REPLY_TEXTAREA: 'div[data-testid="tweetTextarea_0"], div[data-testid="inline_reply_offscreen"]',
    TEXTBOX: 'div[role="textbox"][contenteditable="true"]',
    REPLY_INPUT: 'div[class="DraftEditor-root"]',
    REPLY_BUTTON_SELECTOR: 'button[data-testid="tweetButtonInline"], button[data-testid="tweetButton"]',
    LIKE_BUTTON: 'button[data-testid="like"]',
};

const REPLY_STYLES = [
    { id: 'agree', label: '表示赞同', prompt: '以友好、积极的语气表示赞同，评论简洁且不超过30字，无特殊字符。' },
    { id: 'disagree', label: '表示反对', prompt: '以礼貌、建设性的语气表示反对，评论简洁且不超过30字，无特殊字符。' },
    { id: 'humorous', label: '幽默回复', prompt: '以幽默、友好的语气回复，评论简洁且不超过30字，无特殊字符。' },
    { id: 'collaboration', label: '寻求合作', prompt: '以专业、热情的语气寻求合作机会，评论简洁且不超过30字，无特殊字符。' },
    { id: 'share_opinion', label: '分享观点', prompt: '以中立、清晰的语气分享个人观点，评论简洁且不超过30字，无特殊字符。' },
];

const CONFIG = {
    MAX_ATTEMPTS: 20,
    POLL_INTERVAL_MS: 200,
    MAX_AI_REPLY_LIMIT: 100,
    MAX_RETRY_COUNT: 2, // 最大重试次数
};

const state = {
    aiButton: null,
};

const logger = {
    info: (...args) => console.log('[Lanniao Extension]', ...args),
    warn: (...args) => console.log('[Lanniao Extension]', ...args),
    error: (...args) => console.error('[Lanniao Extension]', ...args),
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

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

function waitForElements(selector, maxAttempts = CONFIG.MAX_ATTEMPTS, interval = CONFIG.POLL_INTERVAL_MS) {
    return new Promise((resolve, reject) => {
        let attempts = 0;
        const check = () => {
            const elements = document.querySelectorAll(selector);
            if (elements) {
                resolve(elements);
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

function extractTweet() {
    try {
        const articleElements = document.querySelectorAll(SELECTORS.ARTICLE);
        if (!articleElements.length) {
            logger.error('No article elements found');
            return null;
        }

        const tweetNormalElement = articleElements[0].querySelector(SELECTORS.TWEET_NORMAL);
        const tweetArticleElement = articleElements[0].querySelector(SELECTORS.TWEET_ARTICLE);
        if (tweetNormalElement) {
            const content = tweetNormalElement?.innerText;
            return { content };
        } else if (tweetArticleElement) {
            const content = tweetArticleElement?.innerText;
            return { content };
        } else {
            const content = "无内容";
            logger.error('Failed to extract content return default no content');
            return { content };
        }
    } catch (error) {
        logger.error('Error extracting tweet:', error.message);
        return null;
    }
}

async function simulateTyping(text) {
    try {
        //const editors = await waitForElements(SELECTORS.TEXTBOX);
        //避免取到私信输入框
        //const editor = editors[editors.length - 1];

        let editor = null;

        const draftEditors = document.querySelectorAll(SELECTORS.REPLY_INPUT);
        for (const draftEditor of draftEditors) {
            if (draftEditor.textContent.includes('回复') || draftEditor.textContent.includes('reply')) {
                editor = draftEditor.querySelector(SELECTORS.TEXTBOX);
                if (editor) break;
            }
        }

        // 如果未找到，抛出错误
        if (!editor) {
            logger.error('No valid reply textbox found');
            throw new Error('No valid reply textbox found');
        }

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
                    setTimeout(typeNextChar, Math.random() * 50 + 80);
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

async function getDefaultModel() {
    return new Promise((resolve) => {
        if (!chrome.storage || !chrome.storage.local) {
            logger.error('chrome.storage.local 不可用，回退到默认模型');
            resolve('gptapi');
            return;
        }
        chrome.storage.local.get(['activeModelSource', 'gptapiModel'], (result) => {
            const modelSource = result.activeModelSource || 'gptapi';
            const model = modelSource === 'gptapi' ? result.gptapiModel || 'grok-3' : modelSource;
            resolve(model);
        });
    });
}

async function getFilterWords() {
    return new Promise((resolve) => {
        if (!chrome.storage || !chrome.storage.local) {
            logger.error('chrome.storage.local 不可用，回退到空过滤词');
            resolve('');
            return;
        }
        chrome.storage.local.get(['activeModelSource', 'googleFilterWords', 'deepseekFilterWords', 'gptapiFilterWords'], (result) => {
            const modelSource = result.activeModelSource || 'gptapi';
            resolve(result[`${modelSource}FilterWords`] || '');
        });
    });
}

async function getQuoteSuffix() {
    return new Promise((resolve) => {
        if (!chrome.storage || !chrome.storage.local) {
            logger.error('chrome.storage.local 不可用，回退到空引用后缀');
            resolve('');
            return;
        }
        chrome.storage.local.get(['activeModelSource', 'googleQuoteSuffix', 'deepseekQuoteSuffix', 'gptapiQuoteSuffix'], (result) => {
            const modelSource = result.activeModelSource || 'gptapi';
            resolve(result[`${modelSource}QuoteSuffix`] || '');
        });
    });
}


async function getCustomPrompt() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['activeModelSource', 'googleCustomPrompt', 'deepseekCustomPrompt', 'gptapiCustomPrompt'], (result) => {
            const modelSource = result.activeModelSource || 'gptapi';
            resolve(result[`${modelSource}CustomPrompt`] || '如果推文内容为空，生成简短的友好评论。不得包含敏感或违规内容，不要有任何特殊字符，或者符号。只输出评论内容。');
        });
    });
}

function createReplyStyleSelector(aiButton, onSelect) {
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

    const rect = aiButton.getBoundingClientRect();
    selector.style.top = `${rect.bottom + window.scrollY + 5}px`;
    selector.style.left = `${rect.left + window.scrollX}px`;

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

        const model = await getDefaultModel();
        createReplyStyleSelector(aiButton, async (style) => {
            let retryCount = 0;
            const maxRetries = CONFIG.MAX_RETRY_COUNT;

            const tryGenerateReply = async () => {
                try {
                    aiButton.disabled = true;
                    textSpan.innerText = retryCount > 0 ? '重试中' : '生成中';

                    const tweet = extractTweet();
                    if (!tweet) throw new Error('Unable to extract tweet');

                    const customPrompt = await getCustomPrompt();
                    const filterWords = await getFilterWords();
                    const quoteSuffix = await getQuoteSuffix();

                    const messages = [
                        {
                            role: 'user',
                            content: `你是一个推特用户，请对以下推文内容发表评论[${tweet.content}] 要求：1. ${style.prompt} ${customPrompt}`
                        }
                    ];

                    const response = await new Promise((resolve, reject) => {
                        chrome.runtime.sendMessage({ action: 'requestAI', messages, model }, (resp) => {
                            if (resp.success) resolve(resp);
                            else reject(new Error(resp.error || 'AI request failed'));
                        });
                    });

                    let replyContent = response.reply.replace(/[\r\n]+/g, '');
                    logger.info('AI reply:', replyContent);

                    replyContent = `${replyContent} ${quoteSuffix}`;

                    const wordsToFilter = filterWords.split(',').map(word => word.trim());
                    const regex = new RegExp(wordsToFilter.join('|'), 'gi');
                    replyContent = replyContent.replace(regex, '');

                    const truncatedReply = replyContent.slice(0, CONFIG.MAX_AI_REPLY_LIMIT);
                    logger.info('after truncatedReply:', truncatedReply);

                    await simulateTyping(truncatedReply);
                    logger.info('AI reply inserted');

                    aiButton.disabled = false;
                    textSpan.innerText = 'AI';
                } catch (error) {
                    retryCount++;
                    if (retryCount <= maxRetries) {
                        logger.warn(`AI request failed, retrying (${retryCount}/${maxRetries}):`, error.message);
                        await tryGenerateReply();
                    } else {
                        logger.error('AI button click failed after retries:', error.message);
                        let errorMessage;
                        if (model === 'google') {
                            errorMessage = `生成回复失败：${error.message}，请检查代理 IP 是否符合 Gemini 的限制。`;
                        } else {
                            errorMessage = `生成回复失败：${error.message}`;
                        }
                        showUserError(errorMessage);
                        aiButton.disabled = false;
                        textSpan.innerText = 'AI';
                    }
                }
            };

            await tryGenerateReply();
        });
    });

    state.aiButton = aiButton;
    return aiButton;
}


async function insertAutoReplyButton() {
    let attempt = 0;
    while (attempt < CONFIG.MAX_ATTEMPTS) {
        try {
            attempt++;
            await sleep(200);
            const replyButton = await waitForElement(SELECTORS.REPLY_BUTTON_SELECTOR);
            const aiButton = createAIButton(replyButton);
            replyButton.parentNode.insertBefore(aiButton, replyButton);
            break;
        } catch (error) {
            if (attempt >= CONFIG.MAX_ATTEMPTS) {
                logger.error('Failed to insert AI button:', error.message);
                showUserError('无法插入 AI 按钮，请稍后重试');
                break;
            }
        }
    }
}

async function addReplyTextAreaListener() {
    try {
        const replyTextArea = await waitForElement(SELECTORS.REPLY_TEXTAREA);
        if (replyTextArea) {
            if (replyTextArea.dataset.listenerAdded === 'true') {
                //console.log('监听器已注入，避免重复');
            } else {
                replyTextArea.removeEventListener('click', insertAutoReplyButton);
                replyTextArea.addEventListener('click', insertAutoReplyButton);
                replyTextArea.dataset.listenerAdded = 'true';
                logger.info('Reply textarea listener added');
            }
        }
    } catch (error) {
        logger.error('Failed to add reply textarea listener:', error.message);
    }
}

async function initPage() {
    try {
        runMonitorWhenReady();
    } catch (error) {
        logger.error('Page initialization failed:', error.message);
    }
}

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
    setTimeout(() => div.remove(), 10000);
}

async function monitorReplyButton() {
    async function checkForReplyButton() {
        const replyButton = document.querySelector(SELECTORS.REPLY_BUTTON_SELECTOR);
        if (replyButton) {
            await addReplyTextAreaListener();
        }
    }

    const observer = new MutationObserver(async (mutations) => {
        for (const mutation of mutations) {
            await checkForReplyButton();
        }
    });

    const config = {
        childList: true,
        subtree: true,
    };

    observer.observe(document.body, config);
    await checkForReplyButton();
}

function runMonitorWhenReady() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(monitorReplyButton, 1000);
    } else {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(monitorReplyButton, 1000);
        });
    }
}

initPage().then(() => {
    chrome.runtime.sendMessage({ action: 'lanniaoContentScriptLoaded' });
});