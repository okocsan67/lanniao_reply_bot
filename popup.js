const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const statusNode = document.getElementById('status');
const replyCountNode = document.getElementById('replyCount');
const likeCountNode = document.getElementById('likeCount');
const repostCountNode = document.getElementById('repostCount');
const batchCountNode = document.getElementById('batchCount');
const failedCountNode = document.getElementById('failedCount');

let refreshTimer = null;

function setStatus(message, isError = false) {
    statusNode.textContent = message;
    statusNode.classList.toggle('error', isError);
}

async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
}

function renderStatus(status) {
    const stats = status?.stats || {};
    replyCountNode.textContent = String(stats.replies || 0);
    likeCountNode.textContent = String(stats.likes || 0);
    repostCountNode.textContent = String(stats.reposts || 0);
    batchCountNode.textContent = String(stats.batches || 0);
    failedCountNode.textContent = String(stats.failed || 0);

    const running = Boolean(status?.running);
    const stopping = Boolean(status?.stopping);
    startButton.disabled = running || stopping;
    stopButton.disabled = !running && !stopping;
    setStatus(status?.statusText || '未开始', status?.status === 'error');
}

async function refreshStatus() {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'lanniaoGetAutoInteractionStatus' });
        if (response?.success) {
            renderStatus(response.status);
        }
    } catch (error) {
        setStatus(error.message || '无法读取状态', true);
    }
}

async function startAutoInteraction() {
    startButton.disabled = true;
    setStatus('正在启动...');

    try {
        const tab = await getActiveTab();
        if (!tab?.id) {
            throw new Error('无法获取当前标签页');
        }

        const response = await chrome.runtime.sendMessage({
            action: 'lanniaoStartAutoInteraction',
            tabId: tab.id,
        });
        if (!response?.success) {
            throw new Error(response?.error || '启动失败');
        }

        renderStatus(response.status);
    } catch (error) {
        setStatus(error.message || '启动失败', true);
        await refreshStatus();
    }
}

async function stopAutoInteraction() {
    stopButton.disabled = true;
    setStatus('正在停止...');

    try {
        const response = await chrome.runtime.sendMessage({ action: 'lanniaoStopAutoInteraction' });
        if (!response?.success) {
            throw new Error(response?.error || '停止失败');
        }
        renderStatus(response.status);
    } catch (error) {
        setStatus(error.message || '停止失败', true);
    }
}

startButton.addEventListener('click', startAutoInteraction);
stopButton.addEventListener('click', stopAutoInteraction);

refreshStatus();
refreshTimer = setInterval(refreshStatus, 1000);

window.addEventListener('unload', () => {
    if (refreshTimer) {
        clearInterval(refreshTimer);
    }
});
