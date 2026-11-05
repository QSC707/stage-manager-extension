/**
 * Stage Manager for Browser - Service Worker
 * Robust, Zero-Ghost Capture Pipeline with Window Serialization & Anti-Race Guard
 */

importScripts('logger.js', 'storage.js');

// Configure Side Panel behavior: open side panel upon clicking the extension icon
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
      console.warn('[StageManager] Failed to set side panel behavior:', err);
    });
  }
  Logger.info('ServiceWorker', '台前调度 Service Worker 已就绪');
});

// Single capture timer per window to prevent overlapping/racing captures
// Key: windowId -> { timer: setTimeout, tabId: number, trigger: string }
const windowCaptureTimers = new Map();

/**
 * Schedule screenshot capture for a window's active tab
 * Cancels any existing capture in this window!
 * @param {number} windowId
 * @param {number} tabId
 * @param {number} delay Delay in milliseconds
 * @param {string} trigger Event reason for diagnostic logs
 */
function scheduleCapture(windowId, tabId, delay = 450, trigger = 'unknown') {
  if (!windowId || !tabId) return;

  // Cancel any pending capture in this window immediately
  if (windowCaptureTimers.has(windowId)) {
    const prev = windowCaptureTimers.get(windowId);
    clearTimeout(prev.timer);
    windowCaptureTimers.delete(windowId);
  }

  const timer = setTimeout(async () => {
    windowCaptureTimers.delete(windowId);
    await captureActiveTab(windowId, tabId, trigger);
  }, delay);

  windowCaptureTimers.set(windowId, { timer, tabId, trigger });
}

/**
 * Safely capture screenshot of the currently active tab
 * @param {number} windowId
 * @param {number} tabId
 * @param {string} trigger
 */
async function captureActiveTab(windowId, tabId, trigger = '') {
  if (!tabId) return;

  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.active || !tab.url) return;

    // Disallowed internal URLs
    const urlLower = tab.url.toLowerCase();
    if (
      urlLower.startsWith('chrome://') ||
      urlLower.startsWith('edge://') ||
      urlLower.startsWith('chrome-extension://') ||
      urlLower.startsWith('devtools://') ||
      urlLower.startsWith('view-source:') ||
      urlLower.startsWith('about:')
    ) {
      return;
    }

    // If tab is still loading its initial HTML, wait for onUpdated 'complete' instead of capturing blank/half-rendered DOM
    if (tab.status === 'loading' && trigger === 'onActivated') {
      Logger.info('Capture', `Tab ${tabId} 仍在加载中，推迟至加载完成时捕获`);
      return;
    }

    const capturedUrl = tab.url;
    const targetWindowId = tab.windowId || windowId;

    // Call captureVisibleTab strictly on the tab's specific window with high initial quality
    chrome.tabs.captureVisibleTab(
      targetWindowId,
      { format: 'jpeg', quality: 95 },
      async (dataUrl) => {
        if (chrome.runtime.lastError || !dataUrl) {
          return;
        }

        // CRITICAL ANTI-RACE GUARD:
        // Double check that the tab is STILL the active, foreground tab in this window!
        try {
          const [currentActive] = await chrome.tabs.query({ active: true, windowId: targetWindowId });
          if (!currentActive || currentActive.id !== tabId) {
            Logger.warn('Capture', `丢弃无效截图: 用户在渲染完成前已切换标签页 (Tab ${tabId} -> ${currentActive?.id})`);
            return;
          }

          // Strict URL Check: tab must not have navigated away while capturing
          if (normalizeUrl(currentActive.url) !== normalizeUrl(capturedUrl)) {
            Logger.warn('Capture', `丢弃无效截图: 标签页 URL 已变更 (${capturedUrl} -> ${currentActive.url})`);
            return;
          }
        } catch (e) {
          return;
        }

        // Downscale and compress screenshot to high-definition Retina-grade thumbnail (~1024px width, WebP 85%)
        const compressedUrl = await compressThumbnail(dataUrl, 1024, 0.85);

        // Save thumbnail into IndexedDB strictly bound to this URL
        await saveThumbnail(tabId, capturedUrl, compressedUrl);

        Logger.capture('Capture', `成功更新高清缩略图: Tab ${tabId} [${trigger}]`, {
          title: tab.title,
          url: capturedUrl
        });

        // Broadcast to sidepanel
        chrome.runtime.sendMessage({
          type: 'THUMBNAIL_UPDATED',
          tabId: tab.id,
          url: capturedUrl,
          dataUrl: compressedUrl
        }).catch(() => {
          // Side panel might be closed, silently ignore
        });
      }
    );
  } catch (err) {
    // Tab might have closed rapidly
  }
}

/**
 * Downscale and compress full-res screenshot to high-definition thumbnail
 * Uses bicubic resampling and WebP (fallback JPEG) with ~1024px width for crisp Retina display
 * @param {string} dataUrl
 * @param {number} targetWidth
 * @param {number} quality
 * @returns {Promise<string>}
 */
async function compressThumbnail(dataUrl, targetWidth = 1024, quality = 0.85) {
  let bitmap = null;
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    bitmap = await createImageBitmap(blob);

    // Calculate proportional dimensions
    const scale = Math.min(1, targetWidth / bitmap.width);
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);

    // Encode to WebP for superior high-DPI clarity and sharp text, fallback to JPEG
    let compressedBlob;
    let mimeType = 'image/webp';
    try {
      compressedBlob = await canvas.convertToBlob({ type: 'image/webp', quality });
    } catch (e) {
      mimeType = 'image/jpeg';
      compressedBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    }

    const buffer = await compressedBlob.arrayBuffer();

    // Fast ArrayBuffer to base64
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
  } catch (err) {
    console.warn('[StageManager] Thumbnail compression error, using raw capture:', err);
    return dataUrl;
  } finally {
    // Explicitly release GPU texture memory
    if (bitmap && typeof bitmap.close === 'function') {
      bitmap.close();
    }
  }
}

// Tab activated listener: Wait 450ms for Chromium compositor buffer swap to prevent old tab ghosting
chrome.tabs.onActivated.addListener((activeInfo) => {
  Logger.info('TabSwitch', `切换至 Tab ${activeInfo.tabId}`);
  scheduleCapture(activeInfo.windowId, activeInfo.tabId, 450, 'onActivated');
});

// Tab updated listener: capture shortly after page finishes loading
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active) {
    // 350ms delay lets client-side JS / React / Vue complete initial hydration
    scheduleCapture(tab.windowId, tabId, 350, 'onUpdated-complete');
  }
});

// Tab removed listener: clean up timers and stored thumbnails
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (windowCaptureTimers.has(removeInfo.windowId)) {
    const current = windowCaptureTimers.get(removeInfo.windowId);
    if (current.tabId === tabId) {
      clearTimeout(current.timer);
      windowCaptureTimers.delete(removeInfo.windowId);
    }
  }
  await removeThumbnail(tabId);
  Logger.info('TabRemoved', `已清理 Tab ${tabId} 的缩略图缓存`);
});

// Listen to commands (e.g. keyboard shortcuts)
chrome.commands.onCommand.addListener(async (command) => {
  if (command === '_execute_action') {
    const currentWindow = await chrome.windows.getCurrent();
    if (chrome.sidePanel && chrome.sidePanel.open) {
      chrome.sidePanel.open({ windowId: currentWindow.id }).catch(() => {});
    }
  }
});

// Message handler from sidepanel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CAPTURE_CURRENT_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) {
        captureActiveTab(tabs[0].windowId, tabs[0].id, 'manual-request');
      }
    });
    sendResponse({ status: 'ok' });
  } else if (message.type === 'CLEAR_ALL_DATA') {
    clearAllThumbnails().then(() => {
      Logger.info('Storage', '已手动清空全部缩略图');
      sendResponse({ status: 'ok' });
    });
    return true; // asynchronous response
  }
});
