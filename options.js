// 模型来源配置
const MODEL_SOURCES = {
    google: { label: '谷歌官方', id: 'google' },
    deepseek: { label: 'DeepSeek 官方', id: 'deepseek' },
    gptapi: { label: 'gptapi.us (第三方聚合)', id: 'gptapi' },
};

// 默认提示词
const DEFAULT_PROMPT = '如果推文内容为空，生成简短的友好评论。不得包含敏感或违规内容，不要有任何特殊字符，或者符号。只输出评论内容。并且评论的语言保持跟推文一致。';

// 显示指定模型来源的配置区域
function showConfigSection(modelSource) {
    document.querySelectorAll('.config-section').forEach(section => {
        section.classList.toggle('active', section.id === `${modelSource}-config`);
    });
}


function saveConfig(modelSource) {
    const apiKey = document.getElementById(`${modelSource}ApiKey`).value.trim();
    const customPrompt = document.getElementById(`${modelSource}CustomPrompt`).value.trim();
    const filterWords = document.getElementById(`${modelSource}FilterWords`).value.trim();
    const quoteSuffix = document.getElementById(`${modelSource}QuoteSuffix`).value.trim();

    const storageData = {
        activeModelSource: modelSource,
        [`${modelSource}ApiKey`]: apiKey,
        [`${modelSource}CustomPrompt`]: customPrompt || DEFAULT_PROMPT,
        [`${modelSource}FilterWords`]: filterWords || '',
        [`${modelSource}QuoteSuffix`]: quoteSuffix || ''
    };

    if (modelSource === 'gptapi') {
        storageData.gptapiModel = document.getElementById('gptapiModel').value;
    }

    if (!apiKey) {
        alert('请输入有效的 API 密钥');
        return;
    }

    chrome.storage.local.set(storageData, () => {
        alert(`${MODEL_SOURCES[modelSource].label} 配置已保存并启用`);
    });
}

function loadConfig() {
    chrome.storage.local.get([
        'activeModelSource',
        'googleApiKey', 'googleCustomPrompt', 'googleFilterWords', 'googleQuoteSuffix',
        'deepseekApiKey', 'deepseekCustomPrompt', 'deepseekFilterWords', 'deepseekQuoteSuffix',
        'gptapiApiKey', 'gptapiCustomPrompt', 'gptapiModel', 'gptapiFilterWords', 'gptapiQuoteSuffix'
    ], (result) => {
        const activeModelSource = result.activeModelSource || 'gptapi';
        document.getElementById('modelSource').value = activeModelSource;
        showConfigSection(activeModelSource);

        for (const source in MODEL_SOURCES) {
            if (result[`${source}ApiKey`]) {
                document.getElementById(`${source}ApiKey`).value = result[`${source}ApiKey`];
            }
            document.getElementById(`${source}CustomPrompt`).value =
                result[`${source}CustomPrompt`] || DEFAULT_PROMPT;
            document.getElementById(`${source}FilterWords`).value =
                result[`${source}FilterWords`] || '';
            document.getElementById(`${source}QuoteSuffix`).value =
                result[`${source}QuoteSuffix`] || '';
        }

        if (result.gptapiModel) {
            document.getElementById('gptapiModel').value = result.gptapiModel;
        }
    });
}


// 初始化下拉框切换事件
document.getElementById('modelSource').addEventListener('change', (e) => {
    showConfigSection(e.target.value);
});

// 为每个启用按钮添加事件监听
for (const source in MODEL_SOURCES) {
    document.getElementById(`${source}Enable`).addEventListener('click', () => {
        saveConfig(source);
    });
}

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', loadConfig);