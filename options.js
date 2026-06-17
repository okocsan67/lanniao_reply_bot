// 默认提示词
const LEGACY_DEFAULT_PROMPT = '如果推文内容为空，生成简短的Web3友好评论。否则生成不得包含敏感或违规内容（如具体投资建议），不要有任何特殊字符，或者符号。只输出评论内容。并且评论的语言保持跟推文一致，使用币圈俚语如HODL、DeFi。';
const HUMAN_DEFAULT_PROMPT = '像一个真实的 X 用户随手回一句，别像机器人、客服或营销号。根据原帖自然接话，可以赞同、轻微调侃，或补一句个人感受；中文口语化，英文帖就用自然英文。可以偶尔用 HODL、DeFi 这类圈内词，但不要硬塞。不要解释、不列点、不加引号、不带话题标签、不写具体投资建议。只输出一条 8 到 28 字的评论；信息不足时也回一句自然短评。';
const DEEPSEEK_DEFAULT_PROMPT = HUMAN_DEFAULT_PROMPT;
const DEFAULT_PROMPT = DEEPSEEK_DEFAULT_PROMPT;
const DEFAULT_AUTO_INTERACTION_MIN_DELAY_SECONDS = 30;
const DEFAULT_AUTO_INTERACTION_MAX_DELAY_SECONDS = 60;
const DEFAULT_AUTO_INTERACTION_BATCH_SIZE = 5;
const MAX_AUTO_INTERACTION_BATCH_SIZE = 20;
const MOJIBAKE_PATTERN = /�|濡傛灉|鎺ㄦ枃|鍥炲|璇勮|鐢熸垚|涓嶅|锛|銆|琛ㄧず/;

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

function showCustomTextarea(show) {
    const textarea = document.getElementById('customPersonalityPrompt');
    textarea.classList.toggle('active', show);
    textarea.style.display = show ? 'block' : 'none';
}

function clampNumber(value, fallback, min, max) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(Math.max(number, min), max);
}

function getAutoInteractionSettingsFromInputs() {
    let minDelay = clampNumber(
        document.getElementById('autoInteractionMinDelaySeconds').value,
        DEFAULT_AUTO_INTERACTION_MIN_DELAY_SECONDS,
        5,
        3600
    );
    let maxDelay = clampNumber(
        document.getElementById('autoInteractionMaxDelaySeconds').value,
        DEFAULT_AUTO_INTERACTION_MAX_DELAY_SECONDS,
        5,
        3600
    );
    if (maxDelay < minDelay) {
        maxDelay = minDelay;
    }

    const batchSize = clampNumber(
        document.getElementById('autoInteractionBatchSize').value,
        DEFAULT_AUTO_INTERACTION_BATCH_SIZE,
        1,
        MAX_AUTO_INTERACTION_BATCH_SIZE
    );

    return { minDelay, maxDelay, batchSize };
}

function saveAutoInteractionSettings() {
    const { minDelay, maxDelay, batchSize } = getAutoInteractionSettingsFromInputs();
    document.getElementById('autoInteractionMinDelaySeconds').value = String(minDelay);
    document.getElementById('autoInteractionMaxDelaySeconds').value = String(maxDelay);
    document.getElementById('autoInteractionBatchSize').value = String(batchSize);
    chrome.storage.local.set({
        autoInteractionMinDelaySeconds: minDelay,
        autoInteractionMaxDelaySeconds: maxDelay,
        autoInteractionBatchSize: batchSize,
    });
}

function saveConfig() {
    const apiKey = document.getElementById('deepseekApiKey').value.trim();
    const customPrompt = document.getElementById('deepseekCustomPrompt').value.trim();
    const filterWords = document.getElementById('deepseekFilterWords').value.trim();
    const quoteSuffix = document.getElementById('deepseekQuoteSuffix').value.trim();

    const storageData = {
        deepseekApiKey: apiKey,
        deepseekCustomPrompt: customPrompt || DEFAULT_PROMPT,
        deepseekFilterWords: filterWords || '',
        deepseekQuoteSuffix: quoteSuffix || '',
        userPersonality: document.getElementById('userPersonality').value,
        customPersonalityPrompt: document.getElementById('userPersonality').value === 'custom' ?
            document.getElementById('customPersonalityPrompt').value : ''
    };

    if (!apiKey) {
        alert('请输入有效的 API 密钥');
        return;
    }

    chrome.storage.local.set(storageData, () => {
        alert('DeepSeek 配置已保存并启用');
    });
}

function loadConfig() {
    chrome.storage.local.get([
        'deepseekApiKey', 'deepseekCustomPrompt', 'deepseekFilterWords', 'deepseekQuoteSuffix',
        'userPersonality', 'customPersonalityPrompt',
        'autoInteractionMinDelaySeconds',
        'autoInteractionMaxDelaySeconds',
        'autoInteractionBatchSize'
    ], (result) => {
        const apiKey = result.deepseekApiKey || '';
        if (apiKey) {
            document.getElementById('deepseekApiKey').value = apiKey;
        }
        const promptValue = normalizeStoredPrompt(result.deepseekCustomPrompt, DEFAULT_PROMPT, {
            replaceLegacyDefault: true,
        });
        document.getElementById('deepseekCustomPrompt').value = promptValue;
        if (result.deepseekCustomPrompt && promptValue !== result.deepseekCustomPrompt) {
            chrome.storage.local.set({ deepseekCustomPrompt: promptValue });
        }
        document.getElementById('deepseekFilterWords').value = result.deepseekFilterWords || '';
        document.getElementById('deepseekQuoteSuffix').value = result.deepseekQuoteSuffix || '';

        if (result.userPersonality) {
            document.getElementById('userPersonality').value = result.userPersonality;
        }
        if (result.customPersonalityPrompt) {
            document.getElementById('customPersonalityPrompt').value = result.customPersonalityPrompt;
        }
        showCustomTextarea(result.userPersonality === 'custom');

        const minDelay = clampNumber(
            result.autoInteractionMinDelaySeconds,
            DEFAULT_AUTO_INTERACTION_MIN_DELAY_SECONDS,
            5,
            3600
        );
        const maxDelay = Math.max(minDelay, clampNumber(
            result.autoInteractionMaxDelaySeconds,
            DEFAULT_AUTO_INTERACTION_MAX_DELAY_SECONDS,
            5,
            3600
        ));
        const batchSize = clampNumber(
            result.autoInteractionBatchSize,
            DEFAULT_AUTO_INTERACTION_BATCH_SIZE,
            1,
            MAX_AUTO_INTERACTION_BATCH_SIZE
        );
        document.getElementById('autoInteractionMinDelaySeconds').value = String(minDelay);
        document.getElementById('autoInteractionMaxDelaySeconds').value = String(maxDelay);
        document.getElementById('autoInteractionBatchSize').value = String(batchSize);
    });
}

// 用户性格切换事件
document.getElementById('userPersonality').addEventListener('change', (e) => {
    const value = e.target.value;
    chrome.storage.local.set({ userPersonality: value });
    showCustomTextarea(value === 'custom');
    if (value !== 'custom') {
        chrome.storage.local.remove('customPersonalityPrompt');
    }
});

// 自定义性格输入事件
document.getElementById('customPersonalityPrompt').addEventListener('input', (e) => {
    chrome.storage.local.set({ customPersonalityPrompt: e.target.value });
});

[
    'autoInteractionMinDelaySeconds',
    'autoInteractionMaxDelaySeconds',
    'autoInteractionBatchSize'
].forEach((id) => {
    document.getElementById(id).addEventListener('change', saveAutoInteractionSettings);
});

document.getElementById('deepseekEnable').addEventListener('click', saveConfig);

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', loadConfig);
