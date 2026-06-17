const SELECTORS = {
    ARTICLE: 'article',
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

const LEGACY_DEFAULT_PROMPT = '如果推文内容为空，生成简短的Web3友好评论。否则生成不得包含敏感或违规内容（如具体投资建议），不要有任何特殊字符，或者符号。只输出评论内容。并且评论的语言保持跟推文一致，使用币圈俚语如HODL、DeFi。';
const HUMAN_DEFAULT_PROMPT = '像一个真实的 X 用户随手回一句，别像机器人、客服或营销号。根据原帖自然接话，可以赞同、轻微调侃，或补一句个人感受；中文口语化，英文帖就用自然英文。可以偶尔用 HODL、DeFi 这类圈内词，但不要硬塞。不要解释、不列点、不加引号、不带话题标签、不写具体投资建议。只输出一条 8 到 28 字的评论；信息不足时也回一句自然短评。';
const DEEPSEEK_DEFAULT_PROMPT = HUMAN_DEFAULT_PROMPT;
const DEFAULT_PROMPT = DEEPSEEK_DEFAULT_PROMPT;
const MOJIBAKE_PATTERN = /�|濡傛灉|鎺ㄦ枃|鍥炲|璇勮|鐢熸垚|涓嶅|锛|銆|琛ㄧず/;
const DEFAULT_PERSONALITY_PROMPT = '你是一个友好且易接近的Web3用户，喜欢DeFi社区互动，回复亲切自然，偶尔提链上机会。';

const CONFIG = {
    MAX_ATTEMPTS: 20,
    POLL_INTERVAL_MS: 200,
    MAX_AI_REPLY_LIMIT: 100,
    MAX_RETRY_COUNT: 2, // 最大重试次数
    MAX_HOME_AUTO_REPLY_COUNT: 20,
    DEFAULT_HOME_AUTO_REPLY_COUNT: 3,
    AUTO_REPLY_DELAY_MS: 1500,
    REPLY_SUBMIT_DELAY_MS: 2000,
};

const state = {
    aiButton: null,
    replyIconListenerAdded: false,
    homeAutoReplyRunning: false,
};

const AI_BUTTON_SELECTOR = '[data-testid="aiReplyButton"], .ai-reply-button';
const AI_WRAPPER_SELECTOR = '[data-ai-reply-wrapper="true"], .ai-reply-button-wrapper';
const AI_STYLE_ID = 'lanniao-ai-reply-button-style';
const AI_SCRIPT_INSTANCE_ID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const logger = {
    info: (...args) => console.log('[Lanniao Extension]', ...args),
    warn: (...args) => console.log('[Lanniao Extension]', ...args),
    error: (...args) => console.error('[Lanniao Extension]', ...args),
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isChromeStorageAvailable() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
}

function getLocalStorage(keys) {
    return new Promise((resolve) => {
        if (!isChromeStorageAvailable()) {
            logger.warn('chrome.storage.local is unavailable, using content script defaults');
            resolve({});
            return;
        }

        try {
            chrome.storage.local.get(keys, (result) => {
                if (chrome.runtime?.lastError) {
                    logger.warn('chrome.storage.local.get failed:', chrome.runtime.lastError.message);
                    resolve({});
                    return;
                }
                resolve(result || {});
            });
        } catch (error) {
            logger.warn('chrome.storage.local.get threw:', error.message);
            resolve({});
        }
    });
}

function setLocalStorage(values) {
    if (!isChromeStorageAvailable()) return;

    try {
        chrome.storage.local.set(values);
    } catch (error) {
        logger.warn('chrome.storage.local.set threw:', error.message);
    }
}

function isLikelyCorruptedText(value) {
    if (!value) return false;

    const questionMarkCount = (value.match(/\?/g) || []).length;
    const chineseCharacterCount = (value.match(/[\u4e00-\u9fff]/g) || []).length;
    return MOJIBAKE_PATTERN.test(value) || questionMarkCount >= 8 && chineseCharacterCount === 0;
}

function normalizeStoredPrompt(value, fallback = DEFAULT_PROMPT, { replaceLegacyDefault = false } = {}) {
    if (!value || isLikelyCorruptedText(value)) {
        return fallback;
    }

    if (replaceLegacyDefault && value.trim() === LEGACY_DEFAULT_PROMPT) {
        return fallback;
    }

    return value;
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

function isVisibleElement(element) {
    if (!element) return false;

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function getScopedReplyEditor(triggerElement = null) {
    const roots = [];
    const triggerRoot = triggerElement ? getComposerRoot(triggerElement) : null;
    if (triggerRoot) {
        roots.push(triggerRoot);
    }
    roots.push(document);

    for (const root of roots) {
        const textboxes = [...root.querySelectorAll(SELECTORS.TEXTBOX)]
            .filter((textbox) => textbox.isContentEditable && isVisibleElement(textbox));
        if (textboxes.length) {
            return textboxes[textboxes.length - 1];
        }
    }

    return null;
}

function normalizeEditorText(value = '') {
    return value.replace(/\u200B/g, '').trim();
}

function normalizeReplyMatchText(value = '') {
    return normalizeEditorText(value).replace(/\s+/g, ' ');
}

function isExpectedReplyText(editorText, expectedText) {
    const expected = normalizeReplyMatchText(expectedText);
    if (!expected) {
        return Boolean(normalizeReplyMatchText(editorText));
    }

    return normalizeReplyMatchText(editorText) === expected;
}

function getEditorPlainText(editor) {
    return normalizeEditorText(editor?.innerText || editor?.textContent || '');
}

function selectEditorContents(editor) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
}

async function replaceEditorText(editor, text) {
    editor.focus();
    selectEditorContents(editor);

    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', text);
    editor.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dataTransfer,
    }));

    await sleep(150);
    const afterPaste = getEditorPlainText(editor);
    if (afterPaste === text) {
        return;
    }

    editor.focus();
    selectEditorContents(editor);
    document.execCommand('delete', false);
    await sleep(50);
    document.execCommand('insertText', false, text);
    editor.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
    }));
}

async function waitForEditorText(editor, expectedText) {
    const expected = normalizeEditorText(expectedText);
    for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS; attempt++) {
        if (getEditorPlainText(editor) === expected) {
            return;
        }

        await sleep(CONFIG.POLL_INTERVAL_MS);
    }

    throw new Error('回复内容未写入输入框');
}

async function writeReplyText(editor, replyText) {
    await replaceEditorText(editor, replyText);
    await waitForEditorText(editor, replyText);
}

function clickElementLikeUser(element) {
    if (!element) return;

    const clickable = element.closest?.('button, [role="button"]') || element;
    clickable.scrollIntoView?.({ block: 'center', inline: 'nearest' });
    clickable.focus?.();

    const rect = clickable.getBoundingClientRect();
    const clientX = Math.floor(rect.left + rect.width / 2);
    const clientY = Math.floor(rect.top + rect.height / 2);
    const baseEvent = {
        view: window,
        bubbles: true,
        cancelable: true,
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
        button: 0,
    };

    const dispatchPointerEvent = (type, buttons = 0) => {
        if (typeof PointerEvent !== 'function') {
            return;
        }

        clickable.dispatchEvent(new PointerEvent(type, {
            ...baseEvent,
            buttons,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
        }));
    };

    const dispatchMouseEvent = (type, buttons = 0) => {
        clickable.dispatchEvent(new MouseEvent(type, {
            ...baseEvent,
            buttons,
        }));
    };

    dispatchPointerEvent('pointerover');
    dispatchPointerEvent('pointerenter');
    dispatchMouseEvent('mouseover');
    dispatchPointerEvent('pointermove');
    dispatchMouseEvent('mousemove');
    dispatchPointerEvent('pointerdown', 1);
    dispatchMouseEvent('mousedown', 1);
    dispatchPointerEvent('pointerup');
    dispatchMouseEvent('mouseup');

    clickable.click();
}

async function simulateTyping(text, triggerElement = null) {
    try {
        const editor = getScopedReplyEditor(triggerElement);

        // 如果未找到，抛出错误
        if (!editor) {
            logger.error('No valid reply textbox found');
            throw new Error('No valid reply textbox found');
        }

        await writeReplyText(editor, text);
        logger.info('Reply text replaced');
    } catch (error) {
        logger.error('Simulate typing failed:', error.message);
        throw error;
    }
}

async function getFilterWords() {
    const result = await getLocalStorage(['deepseekFilterWords']);
    return result.deepseekFilterWords || '';
}

async function getQuoteSuffix() {
    const result = await getLocalStorage(['deepseekQuoteSuffix']);
    return result.deepseekQuoteSuffix || '';
}


async function getCustomPrompt() {
    const result = await getLocalStorage(['deepseekCustomPrompt']);
    const prompt = normalizeStoredPrompt(result.deepseekCustomPrompt, DEFAULT_PROMPT, {
        replaceLegacyDefault: true,
    });
    if (result.deepseekCustomPrompt && prompt !== result.deepseekCustomPrompt) {
        setLocalStorage({ deepseekCustomPrompt: prompt });
    }
    return prompt;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyReplyFilters(replyContent, filterWords) {
    const wordsToFilter = filterWords
        .split(',')
        .map(word => word.trim())
        .filter(Boolean)
        .map(escapeRegExp);

    if (!wordsToFilter.length) {
        return replyContent;
    }

    return replyContent.replace(new RegExp(wordsToFilter.join('|'), 'gi'), '');
}

function postProcessReply(reply, filterWords, quoteSuffix) {
    let replyContent = (reply || '').replace(/[\r\n]+/g, '');
    logger.info('AI reply:', replyContent);

    replyContent = `${replyContent} ${quoteSuffix || ''}`.trim();
    replyContent = applyReplyFilters(replyContent, filterWords || '');

    const truncatedReply = replyContent.slice(0, CONFIG.MAX_AI_REPLY_LIMIT);
    logger.info('after truncatedReply:', truncatedReply);
    return truncatedReply;
}

function isExtensionContextInvalidatedMessage(message = '') {
    return /Extension context invalidated|context invalidated/i.test(message);
}

function createRuntimeMessageError(message) {
    const error = new Error(message || 'Extension runtime unavailable');
    if (isExtensionContextInvalidatedMessage(error.message)) {
        error.isExtensionContextInvalidated = true;
        error.noRetry = true;
    }
    return error;
}

function getReplyGenerationErrorMessage(error) {
    if (error.isExtensionContextInvalidated) {
        return '扩展已重新加载，请刷新当前 X 页面后重试。';
    }

    return `生成回复失败：${error.message}`;
}

function isMissingReplySubmitButtonError(error) {
    return error?.message === 'No reply submit buttons found';
}

function requestAIReply(messages) {
    return new Promise((resolve, reject) => {
        if (!chrome?.runtime?.sendMessage) {
            reject(createRuntimeMessageError('Extension runtime unavailable'));
            return;
        }

        try {
            chrome.runtime.sendMessage({ action: 'requestAI', messages }, (resp) => {
                const runtimeErrorMessage = chrome.runtime?.lastError?.message;
                if (runtimeErrorMessage) {
                    reject(createRuntimeMessageError(runtimeErrorMessage));
                    return;
                }
                if (!resp) {
                    reject(new Error('AI service did not return a response'));
                    return;
                }
                if (resp.success) {
                    resolve(resp);
                    return;
                }

                reject(new Error(resp.error || 'AI request failed'));
            });
        } catch (error) {
            reject(createRuntimeMessageError(error.message));
        }
    });
}

async function generateReplyText(tweetContent, style = REPLY_STYLES[0]) {
    const customPrompt = await getCustomPrompt();
    const filterWords = await getFilterWords();
    const quoteSuffix = await getQuoteSuffix();
    const userPersonality = await getUserPersonality();

    const messages = [
        {
            role: 'user',
            content: `${userPersonality} ${style.prompt} ${customPrompt} 请对以下推文内容发表评论：[${tweetContent || '无内容'}]`
        }
    ];

    logger.info("发送提示词：", messages);

    const response = await requestAIReply(messages);
    return postProcessReply(response.reply, filterWords, quoteSuffix);
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

function injectAIButtonStyles() {
    if (document.getElementById(AI_STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = AI_STYLE_ID;
    style.textContent = `
        button.ai-reply-button,
        button[data-testid="aiReplyButton"] {
            min-width: 48px !important;
            height: 36px !important;
            padding-left: 16px !important;
            padding-right: 16px !important;
            border-radius: 9999px !important;
            background: rgb(29, 155, 240) !important;
            background-color: rgb(29, 155, 240) !important;
            border-color: rgba(0, 0, 0, 0) !important;
            color: #fff !important;
            cursor: pointer !important;
            font-weight: 700 !important;
            opacity: 1 !important;
            pointer-events: auto !important;
        }

        .ai-reply-button-wrapper,
        [data-ai-reply-wrapper="true"] {
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            flex: 0 0 auto !important;
            flex-grow: 0 !important;
            flex-shrink: 0 !important;
            margin: 0 !important;
            opacity: 1 !important;
            position: relative !important;
            background: transparent !important;
        }

        button.ai-reply-button *,
        button[data-testid="aiReplyButton"] * {
            color: #fff !important;
        }

        button.ai-reply-button[aria-busy="true"],
        button[data-testid="aiReplyButton"][aria-busy="true"] {
            background-color: rgb(29, 155, 240) !important;
            cursor: progress !important;
            opacity: 1 !important;
        }
    `;
    document.documentElement.appendChild(style);
}

function isReplySubmitButton(button) {
    const text = (button?.innerText || '').trim().toLowerCase();
    return text === '回复' || text === 'reply';
}

function isComposeSubmitButton(button) {
    const text = (button?.innerText || '').trim().toLowerCase();
    return isReplySubmitButton(button) || ['发帖', '发布', 'post', 'tweet'].includes(text);
}

function getReplySubmitButtons() {
    return [...document.querySelectorAll(SELECTORS.REPLY_BUTTON_SELECTOR)]
        .filter(isReplySubmitButton);
}

function getReplyActionGroup(replyButton) {
    const replyButtonWrapper = replyButton?.parentElement;
    return replyButtonWrapper?.parentElement || null;
}

function getComposerRoot(replyButton) {
    for (let node = replyButton?.parentElement; node && node !== document.body; node = node.parentElement) {
        if (node.querySelector?.(SELECTORS.TEXTBOX) && node.querySelector?.(SELECTORS.REPLY_BUTTON_SELECTOR)) {
            return node;
        }
    }

    return getReplyActionGroup(replyButton) || replyButton?.parentElement || null;
}

function removeDuplicateAIButtons(scope = document, keepButton = null) {
    const keepWrapper = keepButton?.closest(AI_WRAPPER_SELECTOR) || null;
    const wrappers = [...scope.querySelectorAll(AI_WRAPPER_SELECTOR)];
    wrappers.forEach((wrapper) => {
        if (wrapper !== keepWrapper) {
            wrapper.remove();
        }
    });

    const looseButtons = [...scope.querySelectorAll(`button${AI_BUTTON_SELECTOR}`)]
        .filter((button) => !button.closest(AI_WRAPPER_SELECTOR));
    looseButtons.forEach((button) => {
        if (button !== keepButton) {
            button.remove();
        }
    });
}

function applyAIWrapperStyle(aiButtonWrapper) {
    aiButtonWrapper.classList.add('ai-reply-button-wrapper');
    aiButtonWrapper.dataset.aiReplyWrapper = 'true';
    aiButtonWrapper.style.setProperty('display', 'flex', 'important');
    aiButtonWrapper.style.setProperty('align-items', 'center', 'important');
    aiButtonWrapper.style.setProperty('justify-content', 'center', 'important');
    aiButtonWrapper.style.setProperty('flex', '0 0 auto', 'important');
    aiButtonWrapper.style.setProperty('flex-grow', '0', 'important');
    aiButtonWrapper.style.setProperty('flex-shrink', '0', 'important');
    aiButtonWrapper.style.setProperty('margin', '0', 'important');
    aiButtonWrapper.style.setProperty('opacity', '1', 'important');
    aiButtonWrapper.style.setProperty('position', 'relative', 'important');
    aiButtonWrapper.style.setProperty('background', 'transparent', 'important');
}

function createAIButtonWrapper() {
    const aiButtonWrapper = document.createElement('div');
    applyAIWrapperStyle(aiButtonWrapper);
    return aiButtonWrapper;
}

function applyAIButtonStyle(aiButton) {
    aiButton.disabled = false;
    aiButton.removeAttribute('disabled');
    aiButton.setAttribute('aria-disabled', 'false');
    aiButton.style.setProperty('min-width', '48px', 'important');
    aiButton.style.setProperty('height', '36px', 'important');
    aiButton.style.setProperty('padding-left', '16px', 'important');
    aiButton.style.setProperty('padding-right', '16px', 'important');
    aiButton.style.setProperty('border-radius', '9999px', 'important');
    aiButton.style.setProperty('background', 'rgb(29, 155, 240)', 'important');
    aiButton.style.setProperty('background-color', 'rgb(29, 155, 240)', 'important');
    aiButton.style.setProperty('border-color', 'rgba(0, 0, 0, 0)', 'important');
    aiButton.style.setProperty('color', '#fff', 'important');
    aiButton.style.setProperty('cursor', 'pointer', 'important');
    aiButton.style.setProperty('font-weight', '700', 'important');
    aiButton.style.setProperty('opacity', '1', 'important');
    aiButton.style.setProperty('pointer-events', 'auto', 'important');
    aiButton.querySelectorAll('*').forEach((element) => {
        element.style.setProperty('color', '#fff', 'important');
    });
}

function ensureAIButtonPlacement(replyButton) {
    const replyButtonWrapper = replyButton?.parentElement;
    const actionGroup = getReplyActionGroup(replyButton);
    const composerRoot = getComposerRoot(replyButton);
    const scope = composerRoot || actionGroup || document;

    if (!replyButtonWrapper || !actionGroup) return null;

    let aiButton = actionGroup.querySelector(AI_BUTTON_SELECTOR) || scope.querySelector(AI_BUTTON_SELECTOR);
    let aiButtonWrapper = aiButton?.closest(AI_WRAPPER_SELECTOR) || null;

    if (aiButton && aiButton.dataset.aiReplyInstance !== AI_SCRIPT_INSTANCE_ID) {
        if (aiButtonWrapper) {
            aiButtonWrapper.remove();
        } else {
            aiButton.remove();
        }
        aiButton = null;
        aiButtonWrapper = null;
    }

    if (!aiButton) {
        aiButton = createAIButton(replyButton);
    }

    if (!aiButtonWrapper) {
        aiButtonWrapper = createAIButtonWrapper();
        aiButtonWrapper.appendChild(aiButton);
    }

    applyAIWrapperStyle(aiButtonWrapper);
    applyAIButtonStyle(aiButton);

    if (aiButtonWrapper.parentElement !== actionGroup || aiButtonWrapper.nextElementSibling !== replyButtonWrapper) {
        actionGroup.insertBefore(aiButtonWrapper, replyButtonWrapper);
    }

    replyButtonWrapper.dataset.aiReplyAttached = 'true';
    removeDuplicateAIButtons(scope, aiButton);
    return aiButton;
}

function createAIButton(replyButton) {
    injectAIButtonStyles();

    const aiButton = replyButton.cloneNode(true);
    aiButton.classList.add('ai-reply-button');
    aiButton.setAttribute('data-testid', 'aiReplyButton');
    aiButton.dataset.lanniaoAiButton = 'true';
    aiButton.dataset.aiReplyInstance = AI_SCRIPT_INSTANCE_ID;

    const textSpan = aiButton.querySelector('span span') || aiButton.querySelector('span') || aiButton;
    textSpan.innerText = 'AI';

    let isGenerating = false;
    applyAIButtonStyle(aiButton);

    aiButton.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isGenerating) return;

        createReplyStyleSelector(aiButton, async (style) => {
            let retryCount = 0;
            const maxRetries = CONFIG.MAX_RETRY_COUNT;

            const tryGenerateReply = async () => {
                try {
                    isGenerating = true;
                    aiButton.setAttribute('aria-busy', 'true');
                    applyAIButtonStyle(aiButton);
                    textSpan.innerText = retryCount > 0 ? '重试中' : '生成中';

                    const tweet = extractTweet();
                    if (!tweet) throw new Error('Unable to extract tweet');

                    const truncatedReply = await generateReplyText(tweet.content, style);

                    await simulateTyping(truncatedReply, aiButton);
                    logger.info('AI reply inserted');

                    isGenerating = false;
                    aiButton.removeAttribute('aria-busy');
                    applyAIButtonStyle(aiButton);
                    textSpan.innerText = 'AI';
                } catch (error) {
                    retryCount++;
                    if (!error.noRetry && retryCount <= maxRetries) {
                        logger.warn(`AI request failed, retrying (${retryCount}/${maxRetries}):`, error.message);
                        await tryGenerateReply();
                    } else {
                        logger.error('AI button click failed after retries:', error.message);
                        showUserError(getReplyGenerationErrorMessage(error));
                        isGenerating = false;
                        aiButton.removeAttribute('aria-busy');
                        applyAIButtonStyle(aiButton);
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

function normalizeHomeAutoReplyCount(count) {
    const parsedCount = Number.parseInt(count, 10);
    if (!Number.isFinite(parsedCount)) {
        return CONFIG.DEFAULT_HOME_AUTO_REPLY_COUNT;
    }

    return Math.min(Math.max(parsedCount, 1), CONFIG.MAX_HOME_AUTO_REPLY_COUNT);
}

function isXHomePage() {
    return location.href.startsWith('https://x.com/home') || location.href.startsWith('https://twitter.com/home');
}

function isComposePostPage() {
    return /^https:\/\/(x|twitter)\.com\/compose\/post(?:[/?#]|$)/.test(location.href);
}

function isIntentPostPage() {
    return /^https:\/\/(x|twitter)\.com\/intent\/post(?:[/?#]|$)/.test(location.href);
}

function isReplyComposePage() {
    return isComposePostPage() || isIntentPostPage();
}

async function waitForHomePageReady({ requireArticle = false } = {}) {
    for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS * 6; attempt++) {
        if (isXHomePage() && (!requireArticle || document.querySelector(SELECTORS.ARTICLE))) {
            return true;
        }

        await sleep(CONFIG.POLL_INTERVAL_MS);
    }

    throw new Error('X 首页还没准备好');
}

async function recoverHomeRoute() {
    if (isXHomePage()) {
        await waitForHomePageReady();
        return true;
    }

    if (isReplyComposePage()) {
        history.back();
        try {
            await waitForHomePageReady();
            return true;
        } catch (error) {
            history.replaceState(history.state, document.title, '/home');
            window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
            await waitForHomePageReady().catch(() => {});
            return isXHomePage();
        }
    }

    return false;
}

function extractTweetFromArticle(article) {
    const tweetNormalElement = article?.querySelector(SELECTORS.TWEET_NORMAL);
    const tweetArticleElement = article?.querySelector(SELECTORS.TWEET_ARTICLE);
    const content = (tweetNormalElement?.innerText || tweetArticleElement?.innerText || '').trim();
    return { content: content || '无内容' };
}

function getArticleStatusUrl(article) {
    const timeLink = article?.querySelector('a[href*="/status/"] time')?.closest('a');
    if (timeLink?.href) {
        return timeLink.href;
    }

    const statusLink = [...(article?.querySelectorAll('a[href*="/status/"]') || [])]
        .find(link => /\/status\/\d+/.test(link.href));
    return statusLink?.href || '';
}

function getStatusIdFromUrl(statusUrl) {
    try {
        return new URL(statusUrl).pathname.match(/\/status\/(\d+)/)?.[1] || '';
    } catch (error) {
        return '';
    }
}

function isPromotedArticle(article) {
    const lines = (article?.innerText || '')
        .split('\n')
        .map(line => line.trim().toLowerCase())
        .filter(Boolean);
    return lines.includes('广告') || lines.includes('ad') || lines.includes('promoted');
}

function getHomeArticleTargets(limit, excludedStatusIds = []) {
    const seen = new Set();
    const excluded = new Set(excludedStatusIds.filter(Boolean));
    const articles = [...document.querySelectorAll(SELECTORS.ARTICLE)]
        .filter(article => isVisibleElement(article))
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const targets = [];

    for (const article of articles) {
        if (isPromotedArticle(article)) {
            continue;
        }

        const replyIcon = article.querySelector('button[data-testid="reply"]');
        if (!replyIcon || !isVisibleElement(replyIcon)) {
            continue;
        }
        if (getVisibleActionButton(article, ['unlike', 'unretweet'])) {
            continue;
        }

        const tweet = extractTweetFromArticle(article);
        const statusUrl = getArticleStatusUrl(article);
        const statusId = getStatusIdFromUrl(statusUrl);
        const key = statusId || statusUrl || tweet.content.slice(0, 160);
        if (!key || seen.has(key)) {
            continue;
        }
        if (statusId && excluded.has(statusId)) {
            continue;
        }

        seen.add(key);
        targets.push({
            article,
            statusUrl,
            statusId,
            content: tweet.content,
        });

        if (targets.length >= limit) {
            break;
        }
    }

    return targets;
}

async function waitForHomeArticleTargets(limit, excludedStatusIds = []) {
    for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS; attempt++) {
        const targets = getHomeArticleTargets(limit, excludedStatusIds);
        if (targets.length >= limit || attempt >= 8 && targets.length > 0) {
            return targets.slice(0, limit);
        }

        if (attempt > 0 && attempt % 4 === 0) {
            window.scrollBy({ top: window.innerHeight * 0.75, behavior: 'smooth' });
        }
        await sleep(CONFIG.POLL_INTERVAL_MS);
    }

    return getHomeArticleTargets(limit, excludedStatusIds).slice(0, limit);
}

function findLiveArticleForTarget(target) {
    if (target.article?.isConnected) {
        return target.article;
    }

    if (target.statusUrl) {
        const statusPath = new URL(target.statusUrl).pathname;
        return [...document.querySelectorAll(SELECTORS.ARTICLE)]
            .find(article => [...article.querySelectorAll('a[href*="/status/"]')]
                .some(link => {
                    try {
                        return new URL(link.href).pathname === statusPath;
                    } catch (error) {
                        return false;
                    }
                })) || null;
    }

    return [...document.querySelectorAll(SELECTORS.ARTICLE)]
        .find(article => extractTweetFromArticle(article).content === target.content) || null;
}

async function scrollArticleIntoInteractionView(article) {
    if (!article?.isConnected) {
        return false;
    }

    article.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    await sleep(800);
    return article.isConnected && isVisibleElement(article);
}

function serializeHomeInteractionTarget(target) {
    return {
        statusUrl: target.statusUrl,
        statusId: target.statusId,
        content: target.content,
    };
}

async function findLiveArticleForTargetWithScroll(target) {
    let article = findLiveArticleForTarget(target);
    if (article) {
        return article;
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
    await sleep(600);

    for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS; attempt++) {
        article = findLiveArticleForTarget(target);
        if (article) {
            return article;
        }

        window.scrollBy({ top: window.innerHeight * 0.75, behavior: 'smooth' });
        await sleep(350);
    }

    return null;
}

function getReplyEditorInRoot(root) {
    const textboxes = [...(root?.querySelectorAll(SELECTORS.TEXTBOX) || [])]
        .filter((textbox) => textbox.isContentEditable && isVisibleElement(textbox));
    return textboxes[textboxes.length - 1] || null;
}

function getVisibleReplyDialog() {
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')]
        .filter(dialog => isVisibleElement(dialog));
    return dialogs.find(dialog => getReplyEditorInRoot(dialog)) || null;
}

async function waitForReplyDialog() {
    for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS; attempt++) {
        const dialog = getVisibleReplyDialog();
        if (dialog) {
            return dialog;
        }

        await sleep(CONFIG.POLL_INTERVAL_MS);
    }

    throw new Error('未找到回复弹窗');
}

function getComposePageRoot() {
    if (!isReplyComposePage()) {
        return null;
    }

    return document.querySelector('main') || document.body;
}

function getComposerRootFromEditor(editor, fallbackRoot = null) {
    for (let node = editor?.parentElement; node && node !== document.body; node = node.parentElement) {
        if (node.querySelector?.(SELECTORS.TEXTBOX) && node.querySelector?.(SELECTORS.REPLY_BUTTON_SELECTOR)) {
            return node;
        }
    }

    return fallbackRoot;
}

function getReplyComposerContext() {
    const dialog = getVisibleReplyDialog();
    if (dialog) {
        return {
            root: dialog,
            editor: getReplyEditorInRoot(dialog),
            mode: 'dialog',
        };
    }

    const composeRoot = getComposePageRoot();
    if (!composeRoot) {
        return null;
    }

    const editor = getReplyEditorInRoot(composeRoot);
    if (!editor) {
        return null;
    }

    return {
        root: getComposerRootFromEditor(editor, composeRoot),
        editor,
        mode: 'compose-page',
    };
}

async function waitForReplyComposerContext() {
    for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS * 3; attempt++) {
        const context = getReplyComposerContext();
        if (context?.editor) {
            return context;
        }

        await sleep(CONFIG.POLL_INTERVAL_MS);
    }

    throw new Error('未找到回复输入框');
}

function isEnabledReplyButton(button) {
    return button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
}

function getDialogReplySubmitButton(dialog, { allowComposeSubmit = false } = {}) {
    return getDialogReplySubmitCandidates(dialog, { allowComposeSubmit })
        .find(isEnabledReplyButton) || null;
}

function getDialogReplySubmitCandidates(dialog, { allowComposeSubmit = false } = {}) {
    return [...(dialog?.querySelectorAll(SELECTORS.REPLY_BUTTON_SELECTOR) || [])]
        .filter(button => allowComposeSubmit ? isComposeSubmitButton(button) : isReplySubmitButton(button))
        .filter(isVisibleElement);
}

async function waitForDialogReplySubmitButton(dialog, options = {}) {
    for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS; attempt++) {
        const button = getDialogReplySubmitButton(dialog, options);
        if (button) {
            return button;
        }

        await sleep(CONFIG.POLL_INTERVAL_MS);
    }

    throw new Error('回复按钮未启用');
}

async function waitForElementGone(element) {
    for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS * 2; attempt++) {
        if (!element?.isConnected || !isVisibleElement(element)) {
            return;
        }

        await sleep(CONFIG.POLL_INTERVAL_MS);
    }

    throw new Error('回复弹窗未关闭');
}

async function clearEditorText(editor) {
    editor.focus();
    selectEditorContents(editor);
    document.execCommand('delete', false);
    editor.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'deleteContentBackward',
        data: null,
    }));
    await sleep(150);
}

async function discardDraftIfPrompted() {
    await sleep(300);
    const discardButton = [...document.querySelectorAll('button, div[role="button"]')]
        .filter(isVisibleElement)
        .find(button => /^(放弃|Discard|删除|Delete)$/i.test((button.innerText || '').trim()));
    if (discardButton) {
        clickElementLikeUser(discardButton);
        await sleep(300);
    }
}

function findDialogCloseButton(scope) {
    return [...(scope?.querySelectorAll('button[aria-label], div[role="button"][aria-label]') || [])]
        .filter(isVisibleElement)
        .find(button => /^(关闭|Close|返回|Back)$/i.test((button.getAttribute('aria-label') || '').trim())) || null;
}

async function closeReplyDialog(dialog) {
    if (!dialog?.isConnected || !isVisibleElement(dialog)) {
        return;
    }

    const closeButton = findDialogCloseButton(dialog) || findDialogCloseButton(document);

    if (closeButton) {
        clickElementLikeUser(closeButton);
    } else {
        window.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            bubbles: true,
            cancelable: true,
        }));
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            bubbles: true,
            cancelable: true,
        }));
    }

    await discardDraftIfPrompted();
}

async function closeReplyComposerContext(context) {
    if (context?.mode === 'compose-page') {
        await recoverHomeRoute().catch(() => {
            history.back();
        });
        return;
    }

    await closeReplyDialog(context?.root);
}

async function waitForComposerContextClosed(context, { submitButton = null, allowSubmittedFallback = false } = {}) {
    if (context?.mode === 'compose-page') {
        for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS * 15; attempt++) {
            if (!isReplyComposePage()) {
                return;
            }

            if (allowSubmittedFallback && attempt >= 12 && isSubmittedComposerState(context, submitButton)) {
                await recoverHomeRoute().catch(() => {});
                if (!isReplyComposePage()) {
                    return;
                }
            }

            await sleep(CONFIG.POLL_INTERVAL_MS);
        }
        throw new Error('回复编辑页未关闭');
    }

    let closeAttempted = false;
    for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS * 6; attempt++) {
        if (!context?.root?.isConnected || !isVisibleElement(context.root)) {
            return;
        }

        if (allowSubmittedFallback && !closeAttempted && attempt >= 12 && isSubmittedComposerState(context, submitButton)) {
            closeAttempted = true;
            await closeReplyDialog(context.root).catch(() => {});
        }

        await sleep(CONFIG.POLL_INTERVAL_MS);
    }

    throw new Error('回复弹窗未关闭');
}

function isSubmittedComposerState(context, submitButton) {
    if (hasAlreadyPostedComposerNotice(context?.root) || hasAlreadyPostedComposerNotice(document.body)) {
        return true;
    }

    const currentEditor = getReplyEditorInRoot(context?.root)
        || (context?.editor?.isConnected && isVisibleElement(context.editor) ? context.editor : null);
    const currentSubmitButton = getDialogReplySubmitCandidates(context?.root, {
        allowComposeSubmit: context?.mode === 'compose-page',
    }).at(-1) || submitButton;
    const editorIsEmpty = currentEditor ? getEditorPlainText(currentEditor) === '' : true;
    const submitStillEnabled = currentSubmitButton?.isConnected
        && isVisibleElement(currentSubmitButton)
        && isEnabledReplyButton(currentSubmitButton);

    return editorIsEmpty && !submitStillEnabled;
}

function hasAlreadyPostedComposerNotice(scope) {
    const text = (scope?.innerText || scope?.textContent || '').toLowerCase();
    if (!text) {
        return false;
    }

    return text.includes('你已经发过了')
        || text.includes('you already posted')
        || text.includes('you already sent')
        || text.includes('already sent this')
        || text.includes('already posted this');
}

function getLatestReplyComposerContext(fallbackContext = null) {
    const currentContext = getReplyComposerContext();
    if (currentContext?.editor) {
        return currentContext;
    }

    if (fallbackContext?.editor?.isConnected && isVisibleElement(fallbackContext.editor)) {
        return fallbackContext;
    }

    return fallbackContext;
}

async function waitForReplyComposerReadyToSubmit(fallbackContext, fallbackSubmitButton, expectedText = '', { repairText = false } = {}) {
    const expected = normalizeEditorText(expectedText);
    let lastEditorText = '';
    let lastTextRepairAt = 0;

    for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS; attempt++) {
        const currentContext = getLatestReplyComposerContext(fallbackContext);
        const editor = currentContext?.editor;
        let editorText = getEditorPlainText(editor);
        let textMatches = isExpectedReplyText(editorText, expected);
        let currentSubmitButton = getDialogReplySubmitButton(currentContext?.root, {
            allowComposeSubmit: currentContext?.mode === 'compose-page',
        }) || fallbackSubmitButton;

        if (repairText && expected && editor && isVisibleElement(editor) && !textMatches) {
            const shouldRepairNow = !lastTextRepairAt || Date.now() - lastTextRepairAt >= CONFIG.POLL_INTERVAL_MS * 3;
            if (shouldRepairNow) {
                lastTextRepairAt = Date.now();
                try {
                    await writeReplyText(editor, expectedText);
                    editorText = getEditorPlainText(editor);
                    textMatches = isExpectedReplyText(editorText, expected);
                    currentSubmitButton = getDialogReplySubmitButton(currentContext?.root, {
                        allowComposeSubmit: currentContext?.mode === 'compose-page',
                    }) || fallbackSubmitButton;
                } catch (error) {
                    logger.warn('Reply text repair failed, will retry with latest editor:', error.message);
                }
            }
        }

        lastEditorText = editorText;

        if (
            editor
            && isVisibleElement(editor)
            && textMatches
            && currentSubmitButton?.isConnected
            && isVisibleElement(currentSubmitButton)
            && isEnabledReplyButton(currentSubmitButton)
        ) {
            return {
                context: currentContext,
                editor,
                submitButton: currentSubmitButton,
                editorText,
            };
        }

        await sleep(CONFIG.POLL_INTERVAL_MS);
    }

    throw new Error(expected
        ? `回复内容未保持在输入框中，最后读取到：${lastEditorText || '空'}`
        : '回复按钮未启用');
}

function isReplyComposerContextClosed(context) {
    if (context?.mode === 'compose-page') {
        return !isReplyComposePage();
    }

    return !context?.root?.isConnected || !isVisibleElement(context.root);
}

async function waitForComposerSubmitProgress(context, submitButton) {
    for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS * 2; attempt++) {
        if (isReplyComposerContextClosed(context) || isSubmittedComposerState(context, submitButton)) {
            return true;
        }

        await sleep(CONFIG.POLL_INTERVAL_MS);
    }

    return false;
}

async function submitReplyComposer(context, submitButton, expectedText = '') {
    const firstReady = await waitForReplyComposerReadyToSubmit(context, submitButton, expectedText, { repairText: true });
    const expected = normalizeEditorText(expectedText || firstReady.editorText);
    showUserNotice(`回复已写入，${Math.ceil(CONFIG.REPLY_SUBMIT_DELAY_MS / 1000)} 秒后发送`);

    await sleep(CONFIG.REPLY_SUBMIT_DELAY_MS);

    let ready = await waitForReplyComposerReadyToSubmit(firstReady.context, firstReady.submitButton, expected, { repairText: true });
    clickElementLikeUser(ready.submitButton);
    let submitted = await waitForComposerSubmitProgress(ready.context, ready.submitButton);

    if (!submitted) {
        ready = await waitForReplyComposerReadyToSubmit(ready.context, ready.submitButton, expected, { repairText: true });
        clickElementLikeUser(ready.submitButton);
        submitted = await waitForComposerSubmitProgress(ready.context, ready.submitButton);
    }

    if (!submitted) {
        throw new Error('点击回复按钮后未提交');
    }

    if (
        ready.context?.mode === 'compose-page'
        && !isReplyComposerContextClosed(ready.context)
        && isSubmittedComposerState(ready.context, ready.submitButton)
    ) {
        await recoverHomeRoute().catch(() => {
            history.back();
        });
    }

    await sleep(500);
    await waitForComposerContextClosed(ready.context, {
        submitButton: ready.submitButton,
        allowSubmittedFallback: true,
    });

    return {
        editorText: ready.editorText,
        waitedMs: CONFIG.REPLY_SUBMIT_DELAY_MS,
    };
}

async function waitForIntentReplyClosed(context, submitButton) {
    for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS * 15; attempt++) {
        if (!isIntentPostPage()) {
            return;
        }

        if (attempt >= 12 && isSubmittedComposerState(context, submitButton)) {
            await recoverHomeRoute().catch(() => {
                history.back();
            });
            if (!isIntentPostPage()) {
                return;
            }
        }

        await sleep(CONFIG.POLL_INTERVAL_MS);
    }

    throw new Error('回复编辑页未关闭');
}

function showUserNotice(message, type = 'info') {
    const div = document.createElement('div');
    div.style.position = 'fixed';
    div.style.top = '10px';
    div.style.right = '10px';
    div.style.maxWidth = '320px';
    div.style.padding = '10px 12px';
    div.style.backgroundColor = type === 'error' ? '#ff4d4f' : 'rgb(29, 155, 240)';
    div.style.color = '#fff';
    div.style.borderRadius = '5px';
    div.style.zIndex = '9999';
    div.style.fontSize = '14px';
    div.style.lineHeight = '1.4';
    div.textContent = message;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 6000);
}

async function replyToHomeTarget(target, index, total, { dryRun = false } = {}) {
    const article = findLiveArticleForTarget(target);
    if (!article) {
        throw new Error('未找到目标推文');
    }

    const replyText = await generateReplyText(target.content, REPLY_STYLES[0]);
    article.scrollIntoView({ block: 'center', inline: 'nearest' });
    await sleep(500);

    const replyIcon = article.querySelector('button[data-testid="reply"]');
    if (!replyIcon) {
        throw new Error('未找到回复图标');
    }

    showUserNotice(`正在处理 ${index}/${total}`);
    clickElementLikeUser(replyIcon);

    const dialog = await waitForReplyDialog();
    const editor = getReplyEditorInRoot(dialog);
    if (!editor) {
        throw new Error('未找到回复输入框');
    }

    await writeReplyText(editor, replyText);
    await waitForDialogReplySubmitButton(dialog);

    if (dryRun) {
        logger.info('Dry run reply prepared:', replyText);
        await clearEditorText(editor);
        await closeReplyDialog(dialog);
        await waitForElementGone(dialog).catch(() => {});
        return { replyText, dryRun: true };
    }

    const submitButton = await waitForDialogReplySubmitButton(dialog);
    await submitReplyComposer({ root: dialog, editor, mode: 'dialog' }, submitButton, replyText);
    return { replyText };
}

async function replyToArticle(article, replyText, { index = 1, total = 1, dryRun = false } = {}) {
    const replyIcon = article?.querySelector('button[data-testid="reply"]');
    if (!replyIcon || !isVisibleElement(replyIcon)) {
        throw new Error('未找到回复图标');
    }

    showUserNotice(`正在评论 ${index}/${total}`);
    clickElementLikeUser(replyIcon);

    let context = null;
    try {
        context = await waitForReplyComposerContext();
        const editor = context.editor;

        await writeReplyText(editor, replyText);
        const submitButton = await waitForDialogReplySubmitButton(context.root, {
            allowComposeSubmit: context.mode === 'compose-page',
        });

        if (dryRun) {
            logger.info('Dry run home reply prepared:', replyText);
            await clearEditorText(editor);
            await closeReplyComposerContext(context);
            await waitForComposerContextClosed(context).catch(() => {});
            return { changed: false, planned: true, replyText };
        }

        await submitReplyComposer(context, submitButton, replyText);
        return { changed: true, replyText };
    } catch (error) {
        if (context) {
            await closeReplyComposerContext(context).catch(() => {});
            await waitForComposerContextClosed(context).catch(() => {});
        }
        throw error;
    }
}

async function openHomeReplyComposerForTarget({ target, index = 1, total = 1 } = {}) {
    if (!isXHomePage()) {
        throw new Error('请先打开 X 首页 https://x.com/home');
    }

    if (!target?.statusUrl && !target?.statusId) {
        throw new Error('目标推文链接无效');
    }

    const article = await findLiveArticleForTargetWithScroll(target);
    if (!article) {
        throw new Error('未找到目标推文');
    }

    const scrolledToArticle = await scrollArticleIntoInteractionView(article);
    if (!scrolledToArticle) {
        throw new Error('目标推文当前不可见');
    }

    const replyIcon = article.querySelector('button[data-testid="reply"]');
    if (!replyIcon || !isVisibleElement(replyIcon)) {
        throw new Error('未找到回复图标');
    }

    showUserNotice(`正在打开回复 ${index}/${total}`);
    clickElementLikeUser(replyIcon);
    return { opened: true };
}

async function fillOpenedReplyComposer(replyText, { dryRun = false } = {}) {
    const context = await waitForReplyComposerContext();
    const editor = context.editor;

    await writeReplyText(editor, replyText);
    const submitButton = await waitForDialogReplySubmitButton(context.root, {
        allowComposeSubmit: context.mode === 'compose-page',
    });

    if (dryRun) {
        logger.info('Dry run opened reply prepared:', replyText);
        await clearEditorText(editor);
        await closeReplyComposerContext(context);
        await waitForComposerContextClosed(context).catch(() => {});
        return { changed: false, planned: true, replyText };
    }

    const submitResult = await submitReplyComposer(context, submitButton, replyText);
    return {
        changed: true,
        replyText,
        filledText: submitResult.editorText,
        waitedMs: submitResult.waitedMs,
    };
}

async function startHomeAutoReply(count, options = {}) {
    if (state.homeAutoReplyRunning) {
        throw new Error('首页自动回复正在运行');
    }

    if (!isXHomePage()) {
        throw new Error('请先打开 X 首页 https://x.com/home');
    }

    const targetCount = normalizeHomeAutoReplyCount(count);
    state.homeAutoReplyRunning = true;

    try {
        window.scrollTo(0, 0);
        showUserNotice(`准备自动回复前 ${targetCount} 条`);
        await sleep(1000);

        const targets = await waitForHomeArticleTargets(targetCount);
        if (!targets.length) {
            throw new Error('首页未找到可回复的推文');
        }

        let completed = 0;
        let failed = 0;

        for (let index = 0; index < targets.length; index++) {
            try {
                await replyToHomeTarget(targets[index], index + 1, targets.length, options);
                completed++;
            } catch (error) {
                failed++;
                logger.error(`Home auto reply failed at ${index + 1}/${targets.length}:`, error.message);
                showUserNotice(`第 ${index + 1} 条失败：${error.message}`, 'error');
                await sleep(CONFIG.AUTO_REPLY_DELAY_MS);
            }

            await sleep(CONFIG.AUTO_REPLY_DELAY_MS);
        }

        const actionText = options.dryRun ? '生成验证' : '自动回复';
        const summary = `${actionText}完成：成功 ${completed} 条，失败 ${failed} 条`;
        showUserNotice(summary, failed ? 'error' : 'info');
        return {
            requested: targetCount,
            processed: targets.length,
            completed,
            failed,
            dryRun: Boolean(options.dryRun),
        };
    } finally {
        state.homeAutoReplyRunning = false;
    }
}

async function prepareHomeAutoReplies(count, { dryRun = false } = {}) {
    if (!isXHomePage()) {
        throw new Error('请先打开 X 首页 https://x.com/home');
    }

    const targetCount = normalizeHomeAutoReplyCount(count);
    window.scrollTo(0, 0);
    await sleep(1000);

    const targets = await waitForHomeArticleTargets(targetCount);
    if (!targets.length) {
        throw new Error('首页未找到可回复的推文');
    }

    const preparedTargets = [];
    let failed = 0;

    for (let index = 0; index < targets.length; index++) {
        const target = targets[index];
        if (!target.statusUrl) {
            failed++;
            logger.error(`Home target ${index + 1} missing status URL`);
            continue;
        }

        try {
            showUserNotice(`正在生成 ${index + 1}/${targets.length}`);
            const replyText = dryRun
                ? '测试自动回复草稿'
                : await generateReplyText(target.content, REPLY_STYLES[0]);
            preparedTargets.push({
                statusUrl: target.statusUrl,
                content: target.content,
                replyText,
            });
        } catch (error) {
            failed++;
            logger.error(`Failed to prepare reply ${index + 1}/${targets.length}:`, error.message);
            showUserNotice(`第 ${index + 1} 条生成失败：${error.message}`, 'error');
        }

        await sleep(300);
    }

    return {
        requested: targetCount,
        found: targets.length,
        targets: preparedTargets,
        failed,
    };
}

function getVisibleActionButton(root, testIds) {
    return testIds
        .map(testId => root?.querySelector(`button[data-testid="${testId}"]`))
        .find(button => button && isVisibleElement(button)) || null;
}

async function likeArticle(article, { dryRun = false } = {}) {
    if (getVisibleActionButton(article, ['unlike'])) {
        return { changed: false, skipped: true, reason: 'already-liked' };
    }

    const likeButton = getVisibleActionButton(article, ['like']);
    if (!likeButton) {
        return { changed: false, skipped: true, reason: 'like-button-not-found' };
    }

    if (dryRun) {
        return { changed: false, planned: true };
    }

    likeButton.click();
    await sleep(800);
    return { changed: true };
}

function getRepostConfirmButton() {
    const byTestId = document.querySelector('[data-testid="retweetConfirm"]');
    if (byTestId && isVisibleElement(byTestId)) {
        return byTestId;
    }

    return [...document.querySelectorAll('div[role="menuitem"], button, div[role="button"]')]
        .filter(isVisibleElement)
        .find(element => /^(转帖|Repost)$/i.test((element.innerText || '').trim())) || null;
}

async function repostArticle(article, { dryRun = false } = {}) {
    if (getVisibleActionButton(article, ['unretweet'])) {
        return { changed: false, skipped: true, reason: 'already-reposted' };
    }

    const repostButton = getVisibleActionButton(article, ['retweet']);
    if (!repostButton) {
        return { changed: false, skipped: true, reason: 'repost-button-not-found' };
    }

    if (dryRun) {
        return { changed: false, planned: true };
    }

    repostButton.click();
    await sleep(700);

    const confirmButton = getRepostConfirmButton();
    if (!confirmButton) {
        return { changed: false, skipped: true, reason: 'repost-confirm-not-found' };
    }

    confirmButton.click();
    await sleep(1200);
    return { changed: true };
}

async function collectHomeInteractionTargets({ limit, excludedStatusIds = [] } = {}) {
    if (!isXHomePage()) {
        throw new Error('请先打开 X 首页 https://x.com/home');
    }
    await waitForHomePageReady({ requireArticle: true });

    const batchLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 1, 1), CONFIG.MAX_HOME_AUTO_REPLY_COUNT);
    window.scrollTo(0, 0);
    await sleep(1000);

    const targets = await waitForHomeArticleTargets(batchLimit, excludedStatusIds);
    return {
        requested: batchLimit,
        found: targets.length,
        targets: targets.map(serializeHomeInteractionTarget),
        failed: 0,
    };
}

async function prepareHomeInteractionTarget({ target, index = 1, total = 1, dryRun = false } = {}) {
    if (!isXHomePage()) {
        throw new Error('请先打开 X 首页 https://x.com/home');
    }
    await waitForHomePageReady({ requireArticle: true });

    if (!target?.statusUrl || !target?.statusId) {
        throw new Error('目标推文链接无效');
    }

    const article = await findLiveArticleForTargetWithScroll(target);
    if (!article) {
        throw new Error('未找到目标推文');
    }

    showUserNotice(`正在准备互动 ${index}/${total}`);
    const scrolledToArticle = await scrollArticleIntoInteractionView(article);
    if (!scrolledToArticle) {
        throw new Error('目标推文当前不可见');
    }

    const likeResult = await likeArticle(article, { dryRun });
    await scrollArticleIntoInteractionView(article);
    const repostResult = await repostArticle(article, { dryRun });
    const replyText = dryRun
        ? '测试自动回复草稿'
        : await generateReplyText(target.content, REPLY_STYLES[0]);

    return {
        target: {
            ...serializeHomeInteractionTarget(target),
            replyText,
            liked: Boolean(likeResult.changed),
            reposted: Boolean(repostResult.changed),
            likePlanned: Boolean(likeResult.planned),
            repostPlanned: Boolean(repostResult.planned),
        },
    };
}

async function prepareHomeInteractionBatch({ limit, excludedStatusIds = [], dryRun = false } = {}) {
    if (!isXHomePage()) {
        throw new Error('请先打开 X 首页 https://x.com/home');
    }

    const batchLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 1, 1), CONFIG.MAX_HOME_AUTO_REPLY_COUNT);
    window.scrollTo(0, 0);
    await sleep(1000);

    const targets = await waitForHomeArticleTargets(batchLimit, excludedStatusIds);
    const preparedTargets = [];
    let failed = 0;

    for (let index = 0; index < targets.length; index++) {
        const target = targets[index];
        if (!target.statusUrl || !target.statusId) {
            failed++;
            logger.warn(`Home interaction target ${index + 1} missing status URL`);
            continue;
        }

        try {
            const article = findLiveArticleForTarget(target);
            if (!article) {
                throw new Error('未找到目标推文');
            }

            showUserNotice(`正在准备互动 ${index + 1}/${targets.length}`);
            const scrolledToArticle = await scrollArticleIntoInteractionView(article);
            if (!scrolledToArticle) {
                throw new Error('目标推文当前不可见');
            }

            const likeResult = await likeArticle(article, { dryRun });
            await scrollArticleIntoInteractionView(article);
            const repostResult = await repostArticle(article, { dryRun });
            const replyText = dryRun
                ? '测试自动回复草稿'
                : await generateReplyText(target.content, REPLY_STYLES[0]);

            preparedTargets.push({
                statusUrl: target.statusUrl,
                statusId: target.statusId,
                content: target.content,
                replyText,
                liked: Boolean(likeResult.changed),
                reposted: Boolean(repostResult.changed),
                likePlanned: Boolean(likeResult.planned),
                repostPlanned: Boolean(repostResult.planned),
            });
        } catch (error) {
            failed++;
            logger.error(`Failed to prepare interaction ${index + 1}/${targets.length}:`, error.message);
            showUserNotice(`第 ${index + 1} 条准备失败：${error.message}`, 'error');
        }

        await sleep(dryRun ? 100 : 1200);
    }

    return {
        requested: batchLimit,
        found: targets.length,
        targets: preparedTargets,
        failed,
    };
}

function getVisibleTextboxes() {
    return [...document.querySelectorAll(SELECTORS.TEXTBOX)]
        .filter((textbox) => textbox.isContentEditable && isVisibleElement(textbox));
}

function getEnabledReplySubmitButton(root = document, { allowComposeSubmit = false } = {}) {
    return [...root.querySelectorAll(SELECTORS.REPLY_BUTTON_SELECTOR)]
        .filter(button => allowComposeSubmit ? isComposeSubmitButton(button) : isReplySubmitButton(button))
        .find(isEnabledReplyButton) || null;
}

async function waitForIntentReplyComposer() {
    for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS * 3; attempt++) {
        const editor = getVisibleTextboxes().at(-1);
        const replyButton = [...document.querySelectorAll(SELECTORS.REPLY_BUTTON_SELECTOR)]
            .filter(isComposeSubmitButton)
            .at(-1) || null;

        if (editor && replyButton) {
            return { editor, replyButton };
        }

        await sleep(CONFIG.POLL_INTERVAL_MS);
    }

    throw new Error('未找到回复编辑器');
}

async function fillIntentReply(replyText, { dryRun = false } = {}) {
    const { editor } = await waitForIntentReplyComposer();
    await writeReplyText(editor, replyText);

    const submitButton = await (async () => {
        for (let attempt = 0; attempt < CONFIG.MAX_ATTEMPTS * 2; attempt++) {
            const button = getEnabledReplySubmitButton(document, { allowComposeSubmit: true });
            if (button) {
                return button;
            }
            await sleep(CONFIG.POLL_INTERVAL_MS);
        }
        throw new Error('回复按钮未启用');
    })();

    if (dryRun) {
        logger.info('Dry run intent reply prepared:', replyText);
        await clearEditorText(editor);
        return { dryRun: true, replyText };
    }

    await submitReplyComposer({
        root: getComposerRootFromEditor(editor, getComposePageRoot() || document.body),
        editor,
        mode: 'compose-page',
    }, submitButton, replyText);
    return { replyText };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.action === 'lanniaoEnsureHomeReady') {
        waitForHomePageReady({ requireArticle: true })
            .then(() => sendResponse({ success: true }))
            .catch((error) => {
                logger.error('Ensure home ready failed:', error.message);
                sendResponse({ success: false, error: error.message });
            });

        return true;
    }

    if (message?.action === 'lanniaoRecoverHomeRoute') {
        recoverHomeRoute()
            .then((recovered) => sendResponse({ success: recovered }))
            .catch((error) => {
                logger.error('Recover home route failed:', error.message);
                sendResponse({ success: false, error: error.message });
            });

        return true;
    }

    if (message?.action === 'lanniaoCollectHomeInteractionTargets') {
        collectHomeInteractionTargets({
            limit: message.limit,
            excludedStatusIds: message.excludedStatusIds || [],
        })
            .then((result) => sendResponse({ success: true, ...result }))
            .catch((error) => {
                logger.error('Collect home interaction targets failed:', error.message);
                showUserError(error.message);
                sendResponse({ success: false, error: error.message });
            });

        return true;
    }

    if (message?.action === 'lanniaoOpenHomeReplyComposer') {
        openHomeReplyComposerForTarget({
            target: message.target,
            index: message.index,
            total: message.total,
        })
            .then((result) => sendResponse({ success: true, ...result }))
            .catch((error) => {
                logger.error('Open home reply composer failed:', error.message);
                showUserError(error.message);
                sendResponse({ success: false, error: error.message });
            });

        return true;
    }

    if (message?.action === 'lanniaoFillOpenedReplyComposer') {
        fillOpenedReplyComposer(message.replyText, { dryRun: Boolean(message.dryRun) })
            .then((result) => sendResponse({ success: true, ...result }))
            .catch((error) => {
                logger.error('Fill opened reply composer failed:', error.message);
                showUserError(error.message);
                sendResponse({ success: false, error: error.message });
            });

        return true;
    }

    if (message?.action === 'lanniaoPrepareHomeInteractionTarget') {
        prepareHomeInteractionTarget({
            target: message.target,
            index: message.index,
            total: message.total,
            dryRun: Boolean(message.dryRun),
        })
            .then((result) => sendResponse({ success: true, ...result }))
            .catch((error) => {
                logger.error('Prepare home interaction target failed:', error.message);
                showUserError(error.message);
                sendResponse({ success: false, error: error.message });
            });

        return true;
    }

    if (message?.action === 'lanniaoPrepareHomeInteractionBatch') {
        prepareHomeInteractionBatch({
            limit: message.limit,
            excludedStatusIds: message.excludedStatusIds || [],
            dryRun: Boolean(message.dryRun),
        })
            .then((result) => sendResponse({ success: true, ...result }))
            .catch((error) => {
                logger.error('Prepare home interaction batch failed:', error.message);
                showUserError(error.message);
                sendResponse({ success: false, error: error.message });
            });

        return true;
    }

    if (message?.action === 'lanniaoPrepareHomeAutoReplies') {
        prepareHomeAutoReplies(message.count, { dryRun: Boolean(message.dryRun) })
            .then((result) => sendResponse({ success: true, ...result }))
            .catch((error) => {
                logger.error('Prepare home auto replies failed:', error.message);
                showUserError(error.message);
                sendResponse({ success: false, error: error.message });
            });

        return true;
    }

    if (message?.action === 'lanniaoFillIntentReply') {
        fillIntentReply(message.replyText, { dryRun: Boolean(message.dryRun) })
            .then((result) => sendResponse({ success: true, ...result }))
            .catch((error) => {
                logger.error('Fill intent reply failed:', error.message);
                showUserError(error.message);
                sendResponse({ success: false, error: error.message });
            });

        return true;
    }

    if (message?.action === 'lanniaoShowNotice') {
        showUserNotice(message.message || '', message.type || 'info');
        sendResponse({ success: true });
        return false;
    }

    if (message?.action !== 'lanniaoStartHomeAutoReply') {
        return false;
    }

    startHomeAutoReply(message.count, { dryRun: Boolean(message.dryRun) })
        .then((result) => sendResponse({ success: true, ...result }))
        .catch((error) => {
            logger.error('Home auto reply start failed:', error.message);
            showUserError(error.message);
            sendResponse({ success: false, error: error.message });
        });

    return true;
});


async function insertAutoReplyButton({ showError = false } = {}) {
    injectAIButtonStyles();

    let attempt = 0;
    while (attempt < CONFIG.MAX_ATTEMPTS) {
        try {
            attempt++;
            await sleep(200);

            const replyButtons = getReplySubmitButtons();
            if (!replyButtons.length) {
                throw new Error('No reply submit buttons found');
            }

            for (const replyButton of replyButtons) {
                const replyButtonWrapper = replyButton.parentElement;
                const actionGroup = getReplyActionGroup(replyButton);
                const positionedAIButton = ensureAIButtonPlacement(replyButton);
                if (positionedAIButton) {
                    continue;
                }

                const aiButton = createAIButton(replyButton);
                if (replyButtonWrapper && actionGroup) {
                    replyButtonWrapper.dataset.aiReplyAttached = 'true';
                    const aiButtonWrapper = createAIButtonWrapper();
                    aiButtonWrapper.appendChild(aiButton);
                    actionGroup.insertBefore(aiButtonWrapper, replyButtonWrapper);
                } else {
                    replyButton.parentNode.insertBefore(aiButton, replyButton);
                }
            }
            break;
        } catch (error) {
            if (attempt >= CONFIG.MAX_ATTEMPTS) {
                if (isMissingReplySubmitButtonError(error) && !showError) {
                    logger.warn('No reply submit button found; skipping AI button insertion');
                } else {
                    logger.error('Failed to insert AI button:', error.message);
                }
                if (showError) {
                    showUserError('无法插入 AI 按钮，请稍后重试');
                }
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
        const replyButton = getReplySubmitButtons()[0];
        if (replyButton) {
            await insertAutoReplyButton();
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

function addReplyIconListener() {
    if (state.replyIconListenerAdded) return;

    document.addEventListener('click', (event) => {
        const replyIconButton = event.target.closest?.('button[data-testid="reply"]');
        if (!replyIconButton) return;

        [600, 1500, 3000].forEach((delay) => {
            setTimeout(() => {
                insertAutoReplyButton();
            }, delay);
        });
    }, true);

    state.replyIconListenerAdded = true;
}

function runMonitorWhenReady() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(() => {
            addReplyIconListener();
            monitorReplyButton();
        }, 1000);
    } else {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => {
                addReplyIconListener();
                monitorReplyButton();
            }, 1000);
        });
    }
}

async function getUserPersonality() {
    const result = await getLocalStorage(['userPersonality', 'customPersonalityPrompt']);
    const personality = result.userPersonality || 'friendly';

    if (personality === 'custom' && result.customPersonalityPrompt) {
        return result.customPersonalityPrompt;
    }

    const personalities = {
        friendly: DEFAULT_PERSONALITY_PROMPT,
        humorous: '你是一个机智风趣的NFT玩家，回复轻松幽默，带点币圈meme笑点但不夸张，如吐槽熊市。',
        professional: '你是一个专业深刻的链上分析师，回复有见解，逻辑清晰但不生硬，分享Web3趋势。',
        casual: '你是一个随意放松的HODLer，用币圈日常口语回复，接地气，像在Discord闲聊。',
        enthusiastic: '你是一个热情活力的Web3布道者，回复表达FOMO兴奋，积极推动DAO互动。'
    };
    return personalities[personality] || DEFAULT_PERSONALITY_PROMPT;
}

initPage().then(() => {
    chrome.runtime.sendMessage({ action: 'lanniaoContentScriptLoaded' });
});
