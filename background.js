const logger = {
    info: (...args) => console.log('[Lanniao Extension]', ...args),
    error: (...args) => console.error('[Lanniao Extension]', ...args),
};

const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const MAX_HOME_AUTO_REPLY_COUNT = 20;
const AUTO_INTERACTION_BATCH_SIZE = 5;
const MAX_AUTO_INTERACTION_BATCH_SIZE = 20;
const MIN_AUTO_INTERACTION_DELAY_SECONDS = 5;
const MAX_AUTO_INTERACTION_DELAY_SECONDS = 3600;
const DEFAULT_AUTO_INTERACTION_MIN_DELAY_SECONDS = 30;
const DEFAULT_AUTO_INTERACTION_MAX_DELAY_SECONDS = 60;
const AUTO_INTERACTION_SEEN_LIMIT = 500;
const AUTO_INTERACTION_EMPTY_DELAY_MS = 45000;
const TAB_MESSAGE_RETRY_COUNT = 50;
const TAB_MESSAGE_RETRY_INTERVAL_MS = 500;
const TAB_MESSAGE_TIMEOUT_MS = 90000;
const HOME_URL = 'https://x.com/home';
const HOME_ROUTE_RECOVERY_TIMEOUT_MS = 25000;
const HOME_READY_TIMEOUT_MS = 30000;
const AUTO_INTERACTION_STATE_KEY = 'lanniaoAutoInteractionState';
const AUTO_INTERACTION_ALARM_NAME = 'lanniaoAutoInteractionNextCycle';

const autoInteractionState = {
    running: false,
    stopping: false,
    tabId: null,
    status: 'idle',
    statusText: '未开始',
    startedAt: null,
    updatedAt: null,
    stats: {
        replies: 0,
        likes: 0,
        reposts: 0,
        failed: 0,
        skipped: 0,
        batches: 0,
    },
    seenStatusIds: [],
    lastError: '',
    options: {},
    nextRunAt: null,
    waitStatusText: '',
    batchTargets: [],
    batchIndex: 0,
};

let autoInteractionStateHydrated = false;
let autoInteractionStateHydration = null;
let autoInteractionCycleRunning = false;
let autoInteractionTimerId = null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function sleepUnlessStopping(ms, getStatusText = null) {
    const startedAt = Date.now();
    let lastRemainingSeconds = null;

    while (!autoInteractionState.stopping) {
        const elapsed = Date.now() - startedAt;
        const remainingMs = Math.max(ms - elapsed, 0);
        const remainingSeconds = Math.ceil(remainingMs / 1000);

        if (getStatusText && remainingSeconds !== lastRemainingSeconds) {
            updateAutoInteractionState({
                statusText: getStatusText(remainingSeconds),
            });
            lastRemainingSeconds = remainingSeconds;
        }

        if (remainingMs <= 0) {
            break;
        }

        await sleep(Math.min(1000, remainingMs));
    }
}

function normalizeHomeAutoReplyCount(count) {
    const parsedCount = Number.parseInt(count, 10);
    if (!Number.isFinite(parsedCount)) {
        return 3;
    }

    return Math.min(Math.max(parsedCount, 1), MAX_HOME_AUTO_REPLY_COUNT);
}

function clampInteger(value, fallback, min, max) {
    const parsedValue = Number.parseInt(value, 10);
    if (!Number.isFinite(parsedValue)) {
        return fallback;
    }

    return Math.min(Math.max(parsedValue, min), max);
}

function cloneAutoInteractionStatus() {
    const statusText = getAutoInteractionStatusText();
    return {
        running: autoInteractionState.running,
        stopping: autoInteractionState.stopping,
        status: autoInteractionState.status,
        statusText,
        startedAt: autoInteractionState.startedAt,
        updatedAt: autoInteractionState.updatedAt,
        stats: { ...autoInteractionState.stats },
        lastError: autoInteractionState.lastError,
        nextRunAt: autoInteractionState.nextRunAt,
    };
}

function getAutoInteractionStatusText() {
    if (autoInteractionState.running && autoInteractionState.nextRunAt && autoInteractionState.waitStatusText) {
        const remainingSeconds = Math.max(Math.ceil((autoInteractionState.nextRunAt - Date.now()) / 1000), 0);
        return `${autoInteractionState.waitStatusText}：${remainingSeconds} 秒`;
    }

    return autoInteractionState.statusText;
}

function snapshotAutoInteractionState() {
    return {
        running: autoInteractionState.running,
        stopping: autoInteractionState.stopping,
        tabId: autoInteractionState.tabId,
        status: autoInteractionState.status,
        statusText: autoInteractionState.statusText,
        startedAt: autoInteractionState.startedAt,
        updatedAt: autoInteractionState.updatedAt,
        stats: { ...autoInteractionState.stats },
        seenStatusIds: [...autoInteractionState.seenStatusIds],
        lastError: autoInteractionState.lastError,
        options: { ...(autoInteractionState.options || {}) },
        nextRunAt: autoInteractionState.nextRunAt,
        waitStatusText: autoInteractionState.waitStatusText,
        batchTargets: Array.isArray(autoInteractionState.batchTargets)
            ? autoInteractionState.batchTargets.map(target => ({ ...target }))
            : [],
        batchIndex: Number.isFinite(autoInteractionState.batchIndex)
            ? autoInteractionState.batchIndex
            : 0,
    };
}

function persistAutoInteractionState() {
    chrome.storage.local.set({
        [AUTO_INTERACTION_STATE_KEY]: snapshotAutoInteractionState(),
    }).catch((error) => {
        logger.error('Failed to persist auto interaction state:', error.message);
    });
}

async function hydrateAutoInteractionState() {
    if (autoInteractionStateHydrated) {
        return;
    }
    if (autoInteractionStateHydration) {
        await autoInteractionStateHydration;
        return;
    }

    autoInteractionStateHydration = chrome.storage.local.get([AUTO_INTERACTION_STATE_KEY])
        .then((result) => {
            const savedState = result[AUTO_INTERACTION_STATE_KEY];
            if (savedState && typeof savedState === 'object') {
                Object.assign(autoInteractionState, {
                    ...savedState,
                    stats: {
                        replies: 0,
                        likes: 0,
                        reposts: 0,
                        failed: 0,
                        skipped: 0,
                        batches: 0,
                        ...(savedState.stats || {}),
                    },
                    seenStatusIds: Array.isArray(savedState.seenStatusIds) ? savedState.seenStatusIds : [],
                    options: savedState.options || {},
                    batchTargets: Array.isArray(savedState.batchTargets) ? savedState.batchTargets : [],
                    batchIndex: clampInteger(savedState.batchIndex, 0, 0, Array.isArray(savedState.batchTargets) ? savedState.batchTargets.length : 0),
                });
            }
            autoInteractionStateHydrated = true;
        })
        .catch((error) => {
            autoInteractionStateHydrated = true;
            logger.error('Failed to hydrate auto interaction state:', error.message);
        });

    await autoInteractionStateHydration;
}

function resetAutoInteractionState(tabId, options = {}) {
    autoInteractionState.running = true;
    autoInteractionState.stopping = false;
    autoInteractionState.tabId = tabId;
    autoInteractionState.status = 'running';
    autoInteractionState.statusText = '正在启动';
    autoInteractionState.startedAt = Date.now();
    autoInteractionState.updatedAt = Date.now();
    autoInteractionState.stats = {
        replies: 0,
        likes: 0,
        reposts: 0,
        failed: 0,
        skipped: 0,
        batches: 0,
    };
    autoInteractionState.seenStatusIds = [];
    autoInteractionState.lastError = '';
    autoInteractionState.options = { ...options };
    autoInteractionState.nextRunAt = null;
    autoInteractionState.waitStatusText = '';
    autoInteractionState.batchTargets = [];
    autoInteractionState.batchIndex = 0;
    persistAutoInteractionState();
}

function updateAutoInteractionState(values = {}) {
    Object.assign(autoInteractionState, values);
    autoInteractionState.updatedAt = Date.now();
    persistAutoInteractionState();
}

function incrementAutoInteractionStats(values = {}) {
    for (const [key, value] of Object.entries(values)) {
        autoInteractionState.stats[key] = (autoInteractionState.stats[key] || 0) + value;
    }
    autoInteractionState.updatedAt = Date.now();
    persistAutoInteractionState();
}

function rememberStatusId(statusId) {
    if (!statusId || autoInteractionState.seenStatusIds.includes(statusId)) {
        return;
    }

    autoInteractionState.seenStatusIds.push(statusId);
    if (autoInteractionState.seenStatusIds.length > AUTO_INTERACTION_SEEN_LIMIT) {
        autoInteractionState.seenStatusIds.splice(0, autoInteractionState.seenStatusIds.length - AUTO_INTERACTION_SEEN_LIMIT);
    }
    persistAutoInteractionState();
}

async function getAutoInteractionSettings(options = {}) {
    const result = await chrome.storage.local.get([
        'autoInteractionMinDelaySeconds',
        'autoInteractionMaxDelaySeconds',
        'autoInteractionBatchSize',
    ]);
    const minDelaySeconds = clampInteger(
        options.minDelaySeconds ?? result.autoInteractionMinDelaySeconds,
        DEFAULT_AUTO_INTERACTION_MIN_DELAY_SECONDS,
        MIN_AUTO_INTERACTION_DELAY_SECONDS,
        MAX_AUTO_INTERACTION_DELAY_SECONDS
    );
    const maxDelaySeconds = Math.max(
        minDelaySeconds,
        clampInteger(
            options.maxDelaySeconds ?? result.autoInteractionMaxDelaySeconds,
            DEFAULT_AUTO_INTERACTION_MAX_DELAY_SECONDS,
            MIN_AUTO_INTERACTION_DELAY_SECONDS,
            MAX_AUTO_INTERACTION_DELAY_SECONDS
        )
    );
    const batchSize = clampInteger(
        options.batchSize ?? result.autoInteractionBatchSize,
        AUTO_INTERACTION_BATCH_SIZE,
        1,
        MAX_AUTO_INTERACTION_BATCH_SIZE
    );

    return {
        batchSize,
        minDelayMs: minDelaySeconds * 1000,
        maxDelayMs: maxDelaySeconds * 1000,
    };
}

function getAutoInteractionDelayMs(settings) {
    if (settings.maxDelayMs <= settings.minDelayMs) {
        return settings.minDelayMs;
    }

    return Math.floor(settings.minDelayMs + Math.random() * (settings.maxDelayMs - settings.minDelayMs + 1));
}

async function getDeepSeekApiKey() {
    const result = await chrome.storage.local.get(['deepseekApiKey']);
    return {
        apiKey: result.deepseekApiKey
    };
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
        if (changes.deepseekApiKey) {
            logger.info('DeepSeek API key updated:', changes.deepseekApiKey.newValue ? 'set' : 'cleared');
        }
    }
});

async function sendAIRequest(messages) {
    const { apiKey } = await getDeepSeekApiKey();
    if (!apiKey) {
        throw new Error('DeepSeek API key not set. Please configure in options page.');
    }

    const apiUrl = 'https://api.deepseek.com/v1/chat/completions';
    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
    };
    const requestBody = {
        model: DEEPSEEK_MODEL,
        messages,
    };

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
        return data.choices[0].message.content;
    } catch (error) {
        logger.error('AI request failed:', error.message);
        throw error;
    }
}

function getStatusId(statusUrl) {
    try {
        const url = new URL(statusUrl);
        return url.pathname.match(/\/status\/(\d+)/)?.[1] || '';
    } catch (error) {
        return '';
    }
}

function getIntentReplyUrl(statusUrl) {
    const statusId = getStatusId(statusUrl);
    if (!statusId) {
        throw new Error('Invalid status URL: ' + statusUrl);
    }

    return `https://x.com/intent/post?in_reply_to=${statusId}`;
}

function waitForTabLoad(tabId, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error('等待页面加载超时'));
        }, timeoutMs);

        const listener = (updatedTabId, changeInfo, tab) => {
            if (updatedTabId !== tabId) return;
            if (changeInfo.status === 'complete') {
                clearTimeout(timeoutId);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve(tab);
            }
        };

        chrome.tabs.onUpdated.addListener(listener);
    });
}

async function navigateTab(tabId, url) {
    const loadPromise = waitForTabLoad(tabId);
    await chrome.tabs.update(tabId, { url });
    await loadPromise.catch(async (error) => {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.url?.startsWith(url.split('?')[0])) {
            throw error;
        }
    });
    await sleep(1000);
}

async function reloadTab(tabId) {
    const loadPromise = waitForTabLoad(tabId);
    await chrome.tabs.reload(tabId, { bypassCache: true });
    await loadPromise;
    await sleep(1500);
}

function isHomeUrl(url = '') {
    return url.startsWith('https://x.com/home') || url.startsWith('https://twitter.com/home');
}

function isComposePostUrl(url = '') {
    return /^https:\/\/(x|twitter)\.com\/(?:compose|intent)\/post(?:[/?#]|$)/.test(url);
}

async function waitForTabUrl(tabId, predicate, timeoutMs = HOME_ROUTE_RECOVERY_TIMEOUT_MS) {
    const startedAt = Date.now();
    let lastTab = null;

    while (Date.now() - startedAt < timeoutMs) {
        lastTab = await chrome.tabs.get(tabId);
        if (predicate(lastTab.url || '', lastTab)) {
            return lastTab;
        }

        await sleep(500);
    }

    return lastTab || chrome.tabs.get(tabId);
}

async function refreshHomeTimeline(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (isHomeUrl(tab.url || '')) {
        await reloadTab(tabId);
        return;
    }

    await navigateTab(tabId, HOME_URL);
}

async function returnToHome(tabId) {
    const tab = await chrome.tabs.get(tabId);
    const currentUrl = tab.url || '';
    if (isHomeUrl(currentUrl)) {
        return;
    }

    if (isComposePostUrl(currentUrl)) {
        await sendTabMessageWithTimeout(tabId, {
            action: 'lanniaoRecoverHomeRoute',
        }, 15000).catch((error) => {
            logger.error('Content home route recovery failed:', error.message);
        });

        const recoveredTab = await waitForTabUrl(tabId, isHomeUrl, 8000);
        if (isHomeUrl(recoveredTab.url || '')) {
            return;
        }

        await chrome.tabs.goBack(tabId).catch((error) => {
            logger.error('Browser back home route recovery failed:', error.message);
        });

        const backTab = await waitForTabUrl(tabId, isHomeUrl, 8000);
        if (isHomeUrl(backTab.url || '')) {
            return;
        }
    }

    await navigateTab(tabId, HOME_URL);
}

async function ensureHomeReady(tabId) {
    await returnToHome(tabId);
    await sendTabMessageWithTimeout(tabId, {
        action: 'lanniaoEnsureHomeReady',
    }, HOME_READY_TIMEOUT_MS);
}

async function sendTabMessageWithRetry(tabId, message) {
    let lastErrorMessage = '';

    for (let attempt = 0; attempt < TAB_MESSAGE_RETRY_COUNT; attempt++) {
        try {
            const response = await sendTabMessageWithTimeout(tabId, message);
            if (response?.success === false) {
                const responseError = new Error(response.error || '内容脚本执行失败');
                responseError.noRetry = true;
                throw responseError;
            }
            return response;
        } catch (error) {
            lastErrorMessage = error.message;
            if (autoInteractionState.stopping || error.noRetry) {
                break;
            }
            await sleep(TAB_MESSAGE_RETRY_INTERVAL_MS);
        }
    }

    throw new Error(lastErrorMessage || '无法连接页面内容脚本');
}

async function showTabNotice(tabId, message, type = 'info') {
    try {
        await chrome.tabs.sendMessage(tabId, {
            action: 'lanniaoShowNotice',
            message,
            type,
        });
    } catch (error) {
        logger.info('Unable to show tab notice:', error.message);
    }
}

async function openReplyComposerForTarget(tabId, target, index, total) {
    try {
        const response = await sendTabMessageWithTimeout(tabId, {
            action: 'lanniaoOpenHomeReplyComposer',
            target,
            index,
            total,
        }, 15000);

        if (response?.success === false) {
            throw new Error(response.error || '打开回复编辑器失败');
        }
        return response;
    } catch (error) {
        const tab = await waitForTabUrl(tabId, (url) => isComposePostUrl(url) || isHomeUrl(url), 8000);
        if (isComposePostUrl(tab.url || '')) {
            return { success: true, opened: true, navigated: true };
        }

        throw error;
    }
}

function sendTabMessageWithTimeout(tabId, message, timeoutMs = TAB_MESSAGE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error('页面内容脚本响应超时'));
        }, timeoutMs);

        chrome.tabs.sendMessage(tabId, message)
            .then((response) => {
                clearTimeout(timeoutId);
                resolve(response);
            })
            .catch((error) => {
                clearTimeout(timeoutId);
                reject(error);
            });
    });
}

async function runHomeAutoReplyJob(tabId, count, options = {}) {
    const targetCount = normalizeHomeAutoReplyCount(count);
    const originalTab = await chrome.tabs.get(tabId);

    if (!originalTab.url || originalTab.url.startsWith('chrome://')) {
        throw new Error('请先切到可导航的浏览器标签页后再启动');
    }

    await refreshHomeTimeline(tabId);
    await showTabNotice(tabId, `已刷新首页，准备自动回复前 ${targetCount} 条`);
    const prepareResponse = await sendTabMessageWithRetry(tabId, {
        action: 'lanniaoPrepareHomeAutoReplies',
        count: targetCount,
        dryRun: Boolean(options.dryRun),
    });

    const preparedTargets = prepareResponse.targets || [];
    let completed = 0;
    let failed = prepareResponse.failed || 0;

    for (let index = 0; index < preparedTargets.length; index++) {
        const target = preparedTargets[index];
        try {
            const intentUrl = getIntentReplyUrl(target.statusUrl);
            await navigateTab(tabId, intentUrl);
            await sendTabMessageWithRetry(tabId, {
                action: 'lanniaoFillIntentReply',
                replyText: target.replyText,
                dryRun: Boolean(options.dryRun),
            });
            completed++;
            await showTabNotice(tabId, `已处理 ${index + 1}/${preparedTargets.length}`);
        } catch (error) {
            failed++;
            logger.error(`Auto reply target failed ${index + 1}/${preparedTargets.length}:`, error.message);
            await showTabNotice(tabId, `第 ${index + 1} 条失败：${error.message}`, 'error');
        }

        await sleep(1200);
    }

    await returnToHome(tabId).catch((error) => {
        logger.error('Failed to return home:', error.message);
    });

    const summary = `${options.dryRun ? '生成验证' : '自动回复'}完成：成功 ${completed} 条，失败 ${failed} 条`;
    await showTabNotice(tabId, summary, failed ? 'error' : 'info');
    logger.info(summary);

    return {
        requested: targetCount,
        prepared: preparedTargets.length,
        completed,
        failed,
        dryRun: Boolean(options.dryRun),
    };
}

function clearAutoInteractionTimer() {
    if (autoInteractionTimerId) {
        clearTimeout(autoInteractionTimerId);
        autoInteractionTimerId = null;
    }
}

async function clearAutoInteractionSchedule() {
    clearAutoInteractionTimer();
    await chrome.alarms.clear(AUTO_INTERACTION_ALARM_NAME).catch(() => {});
}

async function armAutoInteractionWake(nextRunAt) {
    const delayMs = Math.max(nextRunAt - Date.now(), 0);
    await chrome.alarms.create(AUTO_INTERACTION_ALARM_NAME, { when: nextRunAt });
    clearAutoInteractionTimer();
    if (delayMs < 30000) {
        autoInteractionTimerId = setTimeout(() => {
            runAutoInteractionCycle('timer').catch((error) => {
                logger.error('Auto interaction timer cycle failed:', error.message);
            });
        }, Math.max(delayMs, 1000));
    }
}

async function scheduleNextAutoInteractionCycle(delayMs, waitStatusText) {
    const safeDelayMs = Math.max(Number(delayMs) || 0, 1000);
    const nextRunAt = Date.now() + safeDelayMs;
    updateAutoInteractionState({
        status: 'running',
        nextRunAt,
        waitStatusText,
        statusText: `${waitStatusText}：${Math.ceil(safeDelayMs / 1000)} 秒`,
    });

    await armAutoInteractionWake(nextRunAt);
}

async function stopAutoInteractionNow(statusText = '已停止') {
    await clearAutoInteractionSchedule();
    updateAutoInteractionState({
        running: false,
        stopping: false,
        status: 'stopped',
        statusText,
        nextRunAt: null,
        waitStatusText: '',
        batchTargets: [],
        batchIndex: 0,
    });
}

function shouldStopForMaxItems(maxItems) {
    return maxItems && autoInteractionState.stats.replies >= maxItems;
}

function getCurrentAutoInteractionBatch() {
    const batchTargets = Array.isArray(autoInteractionState.batchTargets)
        ? autoInteractionState.batchTargets
        : [];
    const batchIndex = clampInteger(autoInteractionState.batchIndex, 0, 0, batchTargets.length);
    return { batchTargets, batchIndex };
}

function saveAutoInteractionBatch(batchTargets, batchIndex = 0) {
    const normalizedTargets = Array.isArray(batchTargets)
        ? batchTargets.map(target => ({ ...target }))
        : [];

    updateAutoInteractionState({
        batchTargets: normalizedTargets,
        batchIndex: clampInteger(batchIndex, 0, 0, normalizedTargets.length),
    });
}

function updateAutoInteractionBatchTarget(index, target) {
    const { batchTargets } = getCurrentAutoInteractionBatch();
    if (!target || index < 0 || index >= batchTargets.length) {
        return;
    }

    const nextTargets = batchTargets.map((item, itemIndex) => (
        itemIndex === index ? { ...target } : { ...item }
    ));
    saveAutoInteractionBatch(nextTargets, autoInteractionState.batchIndex);
}

async function runAutoInteractionCycle(source = 'manual') {
    await hydrateAutoInteractionState();
    if (!autoInteractionState.running || autoInteractionState.stopping) {
        return cloneAutoInteractionStatus();
    }
    if (autoInteractionCycleRunning) {
        return cloneAutoInteractionStatus();
    }

    autoInteractionCycleRunning = true;
    await clearAutoInteractionSchedule();

    const options = autoInteractionState.options || {};
    const tabId = autoInteractionState.tabId;
    const dryRun = Boolean(options.dryRun);
    const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : null;

    try {
        if (!tabId) {
            throw new Error('无法获取当前标签页');
        }

        const tab = await chrome.tabs.get(tabId);
        if (!tab.url || tab.url.startsWith('chrome://')) {
            throw new Error('请先切到可导航的浏览器标签页后再启动');
        }

        const interactionSettings = await getAutoInteractionSettings(options);
        const batchSize = interactionSettings.batchSize;
        const fixedItemDelayMs = Number.isFinite(options.itemDelayMs) ? options.itemDelayMs : null;
        const emptyDelayMs = Number.isFinite(options.emptyDelayMs) ? options.emptyDelayMs : AUTO_INTERACTION_EMPTY_DELAY_MS;

        let { batchTargets, batchIndex } = getCurrentAutoInteractionBatch();
        if (batchIndex >= batchTargets.length) {
            batchTargets = [];
            batchIndex = 0;
            saveAutoInteractionBatch([], 0);
        }

        if (!batchTargets.length) {
            incrementAutoInteractionStats({ batches: 1 });
            updateAutoInteractionState({
                status: 'running',
                statusText: `刷新首页，准备第 ${autoInteractionState.stats.batches} 次互动`,
                nextRunAt: null,
                waitStatusText: '',
            });

            await refreshHomeTimeline(tabId);
            await ensureHomeReady(tabId);
            await showTabNotice(tabId, `已刷新首页，准备第 ${autoInteractionState.stats.batches} 次互动`);

            const prepareResponse = await sendTabMessageWithRetry(tabId, {
                action: 'lanniaoCollectHomeInteractionTargets',
                limit: batchSize,
                excludedStatusIds: autoInteractionState.seenStatusIds,
                dryRun,
            });

            const targets = prepareResponse.targets || [];
            if (prepareResponse.failed) {
                incrementAutoInteractionStats({ failed: prepareResponse.failed });
            }

            if (!targets.length) {
                const emptyWaitMs = dryRun ? 1000 : emptyDelayMs;
                await scheduleNextAutoInteractionCycle(emptyWaitMs, '暂时没有新的可互动推文，等待刷新');
                return cloneAutoInteractionStatus();
            }

            batchTargets = targets.map(target => ({ ...target }));
            batchIndex = 0;
            saveAutoInteractionBatch(batchTargets, batchIndex);
        }

        const total = batchTargets.length;
        const currentIndex = batchIndex;
        const displayIndex = currentIndex + 1;
        let target = batchTargets[currentIndex];
        let hasMoreInBatch = false;

        if (!target) {
            saveAutoInteractionBatch([], 0);
            await scheduleNextAutoInteractionCycle(1000, '批次状态异常，等待刷新首页');
            return cloneAutoInteractionStatus();
        }

        try {
            updateAutoInteractionState({
                status: 'running',
                statusText: `正在互动第 ${displayIndex}/${total} 条`,
                nextRunAt: null,
                waitStatusText: '',
            });

            const prepareTargetResponse = await sendTabMessageWithRetry(tabId, {
                action: 'lanniaoPrepareHomeInteractionTarget',
                target,
                index: displayIndex,
                total,
                dryRun,
            });
            target = prepareTargetResponse.target || target;
            updateAutoInteractionBatchTarget(currentIndex, target);
            rememberStatusId(target.statusId);

            updateAutoInteractionState({
                statusText: '正在打开回复框',
            });
            await openReplyComposerForTarget(tabId, target, displayIndex, total);

            updateAutoInteractionState({
                statusText: '正在发送回复',
            });
            const replyResponse = await sendTabMessageWithRetry(tabId, {
                action: 'lanniaoFillOpenedReplyComposer',
                replyText: target.replyText,
                dryRun,
            });
            target.replied = Boolean(replyResponse.changed);
            target.replyPlanned = Boolean(replyResponse.planned);
            updateAutoInteractionBatchTarget(currentIndex, target);

            await returnToHome(tabId).catch((returnError) => {
                logger.error('Failed to recover home after successful interaction:', returnError.message);
            });

            if (target.liked || dryRun && target.likePlanned) {
                incrementAutoInteractionStats({ likes: 1 });
            }
            if (target.reposted || dryRun && target.repostPlanned) {
                incrementAutoInteractionStats({ reposts: 1 });
            }
            if (target.replied || dryRun && target.replyPlanned) {
                incrementAutoInteractionStats({ replies: 1 });
            }
            await showTabNotice(tabId, `互动统计：回复 ${autoInteractionState.stats.replies}，点赞 ${autoInteractionState.stats.likes}，转发 ${autoInteractionState.stats.reposts}`);
        } catch (error) {
            rememberStatusId(target?.statusId);
            incrementAutoInteractionStats({ failed: 1 });
            updateAutoInteractionState({ lastError: error.message });
            logger.error('Auto interaction target failed:', error.message);
            await showTabNotice(tabId, `回复失败：${error.message}`, 'error');
            await returnToHome(tabId).catch((returnError) => {
                logger.error('Failed to recover home after interaction error:', returnError.message);
            });
        } finally {
            const { batchTargets: latestBatchTargets } = getCurrentAutoInteractionBatch();
            const nextBatchIndex = currentIndex + 1;
            if (nextBatchIndex >= latestBatchTargets.length) {
                saveAutoInteractionBatch([], 0);
            } else {
                hasMoreInBatch = true;
                saveAutoInteractionBatch(latestBatchTargets, nextBatchIndex);
            }
        }

        if (autoInteractionState.stopping || shouldStopForMaxItems(maxItems)) {
            await stopAutoInteractionNow(dryRun && maxItems ? '测试完成' : '已停止');
            return cloneAutoInteractionStatus();
        }

        const nextDelayMs = fixedItemDelayMs ?? (
            dryRun ? 1000 : getAutoInteractionDelayMs(interactionSettings)
        );
        await scheduleNextAutoInteractionCycle(
            nextDelayMs,
            hasMoreInBatch ? '等待下一条互动' : '本批完成，等待刷新首页'
        );
        return cloneAutoInteractionStatus();
    } catch (error) {
        logger.error(`Auto interaction cycle failed (${source}):`, error.message);
        await clearAutoInteractionSchedule();
        updateAutoInteractionState({
            running: false,
            stopping: false,
            status: 'error',
            statusText: `已停止：${error.message}`,
            lastError: error.message,
            nextRunAt: null,
            waitStatusText: '',
            batchTargets: [],
            batchIndex: 0,
        });
        if (tabId) {
            await showTabNotice(tabId, `自动互动停止：${error.message}`, 'error').catch(() => {});
        }
        return cloneAutoInteractionStatus();
    } finally {
        autoInteractionCycleRunning = false;
        persistAutoInteractionState();
    }
}

async function runAutoInteractionJob(tabId, options = {}) {
    await hydrateAutoInteractionState();
    if (autoInteractionState.running) {
        throw new Error('自动互动已经在运行');
    }

    resetAutoInteractionState(tabId, options);
    await clearAutoInteractionSchedule();
    runAutoInteractionCycle('start').catch((error) => {
        logger.error('Auto interaction job rejected:', error.message);
    });
    return cloneAutoInteractionStatus();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'lanniaoStartAutoInteraction') {
        (async () => {
            await hydrateAutoInteractionState();
            const tabId = message.tabId || sender.tab?.id;
            if (!tabId) {
                sendResponse({ success: false, error: '无法获取当前标签页' });
                return;
            }
            if (autoInteractionState.running) {
                sendResponse({ success: false, error: '自动互动已经在运行', status: cloneAutoInteractionStatus() });
                return;
            }

            const tab = await chrome.tabs.get(tabId);
            if (!tab.url || tab.url.startsWith('chrome://')) {
                throw new Error('请先切到可导航的浏览器标签页后再启动');
            }

            const status = await runAutoInteractionJob(tabId, {
                dryRun: Boolean(message.dryRun),
                maxItems: message.maxItems,
                batchSize: message.batchSize,
                itemDelayMs: message.itemDelayMs,
                batchDelayMs: message.batchDelayMs,
                emptyDelayMs: message.emptyDelayMs,
            });
            sendResponse({ success: true, status });
        })().catch((error) => {
            sendResponse({ success: false, error: error.message, status: cloneAutoInteractionStatus() });
        });
        return true;
    }

    if (message.action === 'lanniaoStopAutoInteraction') {
        (async () => {
            await hydrateAutoInteractionState();
            if (autoInteractionState.running && autoInteractionState.nextRunAt && !autoInteractionCycleRunning) {
                await stopAutoInteractionNow('已停止');
            } else if (autoInteractionState.running) {
                updateAutoInteractionState({
                    stopping: true,
                    status: 'stopping',
                    statusText: '正在停止，等待当前操作完成',
                });
            }
            sendResponse({ success: true, status: cloneAutoInteractionStatus() });
        })().catch((error) => {
            sendResponse({ success: false, error: error.message, status: cloneAutoInteractionStatus() });
        });
        return true;
    }

    if (message.action === 'lanniaoGetAutoInteractionStatus') {
        (async () => {
            await hydrateAutoInteractionState();
            sendResponse({ success: true, status: cloneAutoInteractionStatus() });
        })().catch((error) => {
            sendResponse({ success: false, error: error.message, status: cloneAutoInteractionStatus() });
        });
        return true;
    }

    if (message.action === 'lanniaoStartHomeAutoReplyJob') {
        const tabId = message.tabId || sender.tab?.id;
        if (!tabId) {
            sendResponse({ success: false, error: '无法获取当前标签页' });
            return false;
        }

        runHomeAutoReplyJob(tabId, message.count, { dryRun: Boolean(message.dryRun) })
            .catch((error) => {
                logger.error('Home auto reply job failed:', error.message);
                showTabNotice(tabId, `自动回复失败：${error.message}`, 'error');
            });
        sendResponse({ success: true });
        return false;
    }

    if (!sender.tab || !sender.url?.startsWith('https://x.com/')) {
        logger.error('Unauthorized message from:', sender.url);
        return false;
    }

    if (message.action === 'requestAI') {
        sendAIRequest(message.messages)
            .then((reply) => sendResponse({ success: true, reply }))
            .catch((error) => sendResponse({ success: false, error: error.message }));
        return true;
    }

    return false;
});

async function restoreAutoInteractionAfterWake() {
    await hydrateAutoInteractionState();
    if (!autoInteractionState.running || autoInteractionState.stopping) {
        return;
    }

    if (!autoInteractionState.nextRunAt || autoInteractionState.nextRunAt <= Date.now() + 1000) {
        runAutoInteractionCycle('restore').catch((error) => {
            logger.error('Auto interaction restore cycle failed:', error.message);
        });
        return;
    }

    await armAutoInteractionWake(autoInteractionState.nextRunAt);
}

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== AUTO_INTERACTION_ALARM_NAME) {
        return;
    }

    runAutoInteractionCycle('alarm').catch((error) => {
        logger.error('Auto interaction alarm cycle failed:', error.message);
    });
});

restoreAutoInteractionAfterWake().catch((error) => {
    logger.error('Auto interaction wake restore failed:', error.message);
});

chrome.runtime.onInstalled.addListener((details) => {
    logger.info('Extension installed/updated:', details.reason);
    if (details.reason === 'install') {
        chrome.runtime.openOptionsPage();
    }
});
