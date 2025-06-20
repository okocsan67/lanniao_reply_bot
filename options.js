document.getElementById('save').addEventListener('click', () => {
    const grokApiKey = document.getElementById('grokApiKey').value.trim();
    const geminiApiKey = document.getElementById('geminiApiKey').value.trim();
    const defaultModel = document.getElementById('defaultModel').value;
    const customPrompt = document.getElementById('customPrompt').value.trim();

    if (!grokApiKey && !geminiApiKey) {
        alert('请至少输入一个有效的 API 密钥');
        return;
    }

    chrome.storage.local.set({
        grokApiKey: grokApiKey || null,
        geminiApiKey: geminiApiKey || null,
        defaultModel: defaultModel,
        customPrompt: customPrompt || '如果推文内容为空，生成简短的友好评论。不得包含敏感或违规内容，不要有任何特殊字符，或者符号。只输出评论内容。'
    }, () => {
        alert('设置已保存');
    });
});

chrome.storage.local.get(['grokApiKey', 'geminiApiKey', 'defaultModel', 'customPrompt'], (result) => {
    if (result.grokApiKey) {
        document.getElementById('grokApiKey').value = result.grokApiKey;
    }
    if (result.geminiApiKey) {
        document.getElementById('geminiApiKey').value = result.geminiApiKey;
    }
    if (result.defaultModel) {
        document.getElementById('defaultModel').value = result.defaultModel;
    }
    if (result.customPrompt) {
        document.getElementById('customPrompt').value = result.customPrompt;
    } else {
        document.getElementById('customPrompt').value = '如果推文内容为空，生成简短的友好评论。不得包含敏感或违规内容，不要有任何特殊字符，或者符号。只输出评论内容。';
    }
});