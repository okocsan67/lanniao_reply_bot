const logger = {
    info: (...args) => console.log('[Lanniao Extension]', ...args),
    error: (...args) => console.error('[Lanniao Extension]', ...args),
};

async function getApiKey(model) {
    const result = await chrome.storage.local.get(['grokApiKey', 'geminiApiKey']);
    if (model === 'grok-3') {
        return result.grokApiKey;
    } else if (model === 'gemini') {
        return result.geminiApiKey;
    }
    return null;
}

async function getDefaultModel() {
    const result = await chrome.storage.local.get(['defaultModel']);
    return result.defaultModel || 'grok-3';
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        if (changes.grokApiKey) {
            logger.info('Grok API key updated:', changes.grokApiKey.newValue ? 'set' : 'cleared');
        }
        if (changes.geminiApiKey) {
            logger.info('Gemini API key updated:', changes.geminiApiKey.newValue ? 'set' : 'cleared');
        }
        if (changes.defaultModel) {
            logger.info('Default model updated:', changes.defaultModel.newValue);
        }
    }
});

async function sendAIRequest(messages, model) {
    const apiKey = await getApiKey(model);
    if (!apiKey) {
        throw new Error(`${model} API key not set. Please configure in options page.`);
    }

    let apiUrl, requestBody, headers;
    if (model === 'grok-3') {
        apiUrl = 'https://api.gptapi.us/v1/chat/completions';
        headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        };
        requestBody = {
            model: 'grok-3',
            messages,
        };
    } else if (model === 'gemini') {
        apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
        headers = {
            'Content-Type': 'application/json',
        };
        requestBody = {
            contents: messages.map(message => ({
                parts: [{ text: message.content }],
            })),
        };
    } else {
        throw new Error('Unsupported model: ' + model);
    }

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        logger.info('AI response:', data);
        return model === 'grok-3' ? data.choices[0].message.content : data.candidates[0].content.parts[0].text;
    } catch (error) {
        logger.error('AI request failed:', error.message);
        throw error;
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!sender.tab || !sender.url.startsWith('https://x.com/')) {
        logger.error('Unauthorized message from:', sender.url);
        return;
    }

    if (message.action === 'requestAI') {
        const model = message.model || getDefaultModel();
        sendAIRequest(message.messages, model)
            .then((reply) => sendResponse({ success: true, reply }))
            .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;
    }
});

chrome.runtime.onInstalled.addListener((details) => {
    logger.info('Extension installed/updated:', details.reason);
    if (details.reason === 'install') {
        chrome.runtime.openOptionsPage();
    }
});