// options.js
document.getElementById('save').addEventListener('click', () => {
    const apiKey = document.getElementById('apiKey').value.trim();
    if (!apiKey) {
        alert('请输入有效的 OpenAI API 密钥');
        return;
    }

    chrome.storage.local.set({ openaiApiKey: apiKey }, () => {
        alert('API 密钥已保存');
        document.getElementById('apiKey').value = apiKey; // 清空输入框
    });
});

// 加载已保存的密钥（可选，供用户查看）
chrome.storage.local.get(['openaiApiKey'], (result) => {
    if (result.openaiApiKey) {
        document.getElementById('apiKey').placeholder = result.openaiApiKey;
        document.getElementById('apiKey').value = result.openaiApiKey;
    }
});