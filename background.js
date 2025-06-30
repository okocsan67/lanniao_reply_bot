const logger = {
    info: (...args) => console.log('[Lanniao Extension]', ...args),
    error: (...args) => console.error('[Lanniao Extension]', ...args),
};

async function getApiKey(modelSource) {
    const result = await chrome.storage.local.get([
        'googleApiKey',
        'deepseekApiKey',
        'gptapiApiKey',
        'gptapiModel'
    ]);
    return {
        apiKey: result[`${modelSource}ApiKey`],
        gptapiModel: modelSource === 'gptapi' ? result.gptapiModel || 'gpt-4o-mini' : null
    };
}

async function getDefaultModel() {
    const result = await chrome.storage.local.get(['activeModelSource', 'gptapiModel']);
    return {
        modelSource: result.activeModelSource || 'gptapi',
        model: result.activeModelSource === 'gptapi' ? result.gptapiModel || 'gpt-4o-mini' : result.activeModelSource
    };
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        if (changes.googleApiKey) {
            logger.info('Google API key updated:', changes.googleApiKey.newValue ? 'set' : 'cleared');
        }
        if (changes.deepseekApiKey) {
            logger.info('DeepSeek API key updated:', changes.deepseekApiKey.newValue ? 'set' : 'cleared');
        }
        if (changes.gptapiApiKey) {
            logger.info('gptapi.us API key updated:', changes.gptapiApiKey.newValue ? 'set' : 'cleared');
        }
        if (changes.activeModelSource) {
            logger.info('Active model source updated:', changes.activeModelSource.newValue);
        }
        if (changes.gptapiModel) {
            logger.info('gptapi.us model updated:', changes.gptapiModel.newValue);
        }
    }
});

async function sendAIRequest(messages, modelSource, model) {
    const { apiKey, gptapiModel } = await getApiKey(modelSource);
    if (!apiKey) {
        throw new Error(`${modelSource} API key not set. Please configure in options page.`);
    }

    let apiUrl, requestBody, headers;
    if (modelSource === 'gptapi') {
        apiUrl = 'https://api.gptapi.us/v1/chat/completions';
        headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        };
        requestBody = {
            model: gptapiModel || 'gpt-4o-mini',
            messages,
        };
    } else if (modelSource === 'google') {
        apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
        headers = {
            'Content-Type': 'application/json',
        };
        requestBody = {
            contents: messages.map(message => ({
                parts: [{ text: message.content }],
            })),
        };
    } else if (modelSource === 'deepseek') {
        apiUrl = 'https://api.deepseek.com/v1/chat/completions'; // 占位，需替换
        headers = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
        };
        requestBody = {
            model: 'deepseek',
            messages,
        };
    } else {
        throw new Error('Unsupported model source: ' + modelSource);
    }

    try {
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData.error?.message || `HTTP error: ${response.status} ${response.statusText}`;
            logger.error('AI request failed:', errorMessage);
            throw new Error(errorMessage);
        }

        const data = await response.json();
        logger.info('AI response:', data);
        return modelSource === 'google' ? data.candidates[0].content.parts[0].text : data.choices[0].message.content;
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
        getDefaultModel().then(({ modelSource, model }) => {
            sendAIRequest(message.messages, modelSource, model)
                .then((reply) => sendResponse({ success: true, reply }))
                .catch((error) => sendResponse({ success: false, error: error.message }));
        });
        return true;
    }
});

chrome.runtime.onInstalled.addListener((details) => {
    logger.info('Extension installed/updated:', details.reason);
    if (details.reason === 'install') {
        chrome.runtime.openOptionsPage();
    }
});