/**
 * Stage Manager for Browser - Side Panel Controller
 * (Strict URL Validation, Zero-Mismatch Thumbnail Cache & Keyed DOM Reconciliation)
 */

// State
let allTabs = [];
let activeTabId = null;
let currentWindowId = null;
let searchQuery = '';
let refreshScheduled = false;

// In-Memory Thumbnail Cache: tabId -> { url: string, dataUrl: string }
const thumbnailCache = new Map();

// DOM Elements
const pinnedStageSection = document.getElementById('pinned-stage-section');
const pinnedGrid = document.getElementById('pinned-grid');
const pinnedCountEl = document.getElementById('pinned-count');
const stagesList = document.getElementById('stages-list');
const inactiveSectionLabel = document.getElementById('inactive-section-label');
const emptyState = document.getElementById('empty-state');
const tabCountEl = document.getElementById('tab-count');
const btnNewTab = document.getElementById('btn-new-tab');
const btnSearchToggle = document.getElementById('btn-search-toggle');
const btnMinimapToggle = document.getElementById('btn-minimap-toggle');
const btnLogsToggle = document.getElementById('btn-logs-toggle');
const bodyWrapper = document.getElementById('body-wrapper');
const stageCorridor = document.getElementById('stage-corridor');
const searchBar = document.getElementById('search-bar');
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const tabContextMenu = document.getElementById('tab-context-menu');
let contextMenuTargetTab = null;

// Minimap DOM Elements
const smMinimap = document.getElementById('sm-minimap');
const btnMinimapPos = document.getElementById('btn-minimap-pos');
const minimapScrollContainer = document.getElementById('minimap-scroll-container');
const minimapTrack = document.getElementById('minimap-track');
const minimapSlider = document.getElementById('minimap-slider');
const minimapPopover = document.getElementById('minimap-popover');
const popoverFavicon = document.getElementById('popover-favicon');
const popoverTitle = document.getElementById('popover-title');
const popoverPreview = document.getElementById('popover-preview');

// Minimap State & Drag Cache
let minimapEnabled = localStorage.getItem('sm_minimap_enabled') !== 'false';
let minimapPosition = localStorage.getItem('sm_minimap_position') || 'right';
let isDraggingSlider = false;
let dragStartY = 0;
let dragStartScrollTop = 0;
let dragContainerHeight = 0;
let dragSliderHeight = 0;
let dragMaxSliderTravel = 0;
let dragMaxCorridorScroll = 0;
let sliderUpdateScheduled = false;
let activePopoverTabId = null;

// Diagnostic Drawer DOM Elements
const logsDrawer = document.getElementById('logs-drawer');
const logsContent = document.getElementById('logs-content');
const logsCountEl = document.getElementById('logs-count');
const btnCopyLogs = document.getElementById('btn-copy-logs');
const btnClearLogs = document.getElementById('btn-clear-logs');
const btnCleanDb = document.getElementById('btn-clean-db');
const btnCloseLogs = document.getElementById('btn-close-logs');

/**
 * Initialize Stage Manager
 */
async function init() {
  const currentWindow = await chrome.windows.getCurrent();
  currentWindowId = currentWindow.id;

  Logger.info('SidePanel', `侧边栏就绪 (窗口 ID: ${currentWindowId})`);

  // 1. Fetch current tabs first to establish source of truth for URLs
  allTabs = await chrome.tabs.query({ windowId: currentWindowId });
  const activeTab = allTabs.find(t => t.active);
  activeTabId = activeTab ? activeTab.id : (allTabs[0] ? allTabs[0].id : null);

  const tabUrlMap = new Map();
  for (const t of allTabs) {
    tabUrlMap.set(t.id, normalizeUrl(t.url));
  }

  // 2. Prune stale/corrupted thumbnails from previous sessions
  await pruneStaleThumbnails(tabUrlMap);

  // 3. Preload and strictly validate thumbnails from IndexedDB against current tabs
  try {
    const allCached = await getAllThumbnails();
    if (Array.isArray(allCached)) {
      for (const item of allCached) {
        if (item && item.tabId && item.dataUrl) {
          const tabId = Number(item.tabId);
          const currentTabUrl = tabUrlMap.get(tabId);
          const itemUrl = normalizeUrl(item.url);

          // STRICT CHECK: Only use cached thumbnail if the tab exists AND URL matches!
          if (currentTabUrl && itemUrl && currentTabUrl === itemUrl) {
            thumbnailCache.set(tabId, {
              url: itemUrl,
              dataUrl: item.dataUrl
            });
          }
        }
      }
    }
  } catch (e) {
    Logger.warn('SidePanel', '预加载缩略图异常:', e);
  }

  // 4. Initial render with pre-warmed memory cache
  render();

  // 5. Setup Event Listeners
  setupEventListeners();
  setupMinimapInteractions();
  setupDiagnosticDrawer();
  setupContextMenuInteractions();

  // 6. Request capture for currently active tab
  chrome.runtime.sendMessage({ type: 'CAPTURE_CURRENT_TAB' }).catch(() => {});
}

/**
 * Schedule refresh on next animation frame to coalesce rapid tab events
 */
function scheduleRefresh() {
  if (refreshScheduled) return;
  refreshScheduled = true;
  requestAnimationFrame(async () => {
    refreshScheduled = false;
    await refreshTabs();
  });
}

/**
 * Refresh tabs list and render
 */
async function refreshTabs() {
  try {
    allTabs = await chrome.tabs.query({ windowId: currentWindowId });
    const activeTab = allTabs.find(t => t.active);
    activeTabId = activeTab ? activeTab.id : (allTabs[0] ? allTabs[0].id : null);

    render();
  } catch (err) {
    Logger.error('SidePanel', '获取标签页失败:', err);
  }
}

/**
 * Main Render function with Keyed DOM Reconciliation (Zero-Flicker)
 */
function render() {
  let displayTabs = allTabs;

  // Apply search filter if query exists
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase().trim();
    displayTabs = allTabs.filter(t =>
      (t.title && t.title.toLowerCase().includes(q)) ||
      (t.url && t.url.toLowerCase().includes(q))
    );
  }

  if (tabCountEl) {
    tabCountEl.textContent = `${allTabs.length} 个标签`;
  }

  if (displayTabs.length === 0) {
    if (pinnedStageSection) pinnedStageSection.style.display = 'none';
    if (pinnedGrid) pinnedGrid.innerHTML = '';
    stagesList.innerHTML = '';
    inactiveSectionLabel.style.display = 'none';
    emptyState.style.display = 'flex';
    if (minimapTrack) minimapTrack.innerHTML = '';
    if (minimapSlider) minimapSlider.style.display = 'none';
    hideMinimapPopover();
    return;
  }

  emptyState.style.display = 'none';

  // Partition tabs into Pinned and Unpinned
  const pinnedTabs = displayTabs.filter(t => t.pinned);
  const unpinnedTabs = displayTabs.filter(t => !t.pinned);

  // 1. Render Top Pinned Tabs Module (Constant adaptive square grid)
  if (pinnedTabs.length > 0) {
    pinnedStageSection.style.display = 'block';
    pinnedCountEl.textContent = pinnedTabs.length;
    renderPinnedGrid(pinnedTabs);
  } else {
    pinnedStageSection.style.display = 'none';
    pinnedGrid.innerHTML = '';
  }

  // 2. Render Unpinned Tabs in Stage Corridor
  // Active tab renders as a sleek horizontal title bar (WITHOUT thumbnail)
  // Inactive tabs render as 3D stage thumbnail cards
  const corridorTabs = unpinnedTabs;

  if (corridorTabs.length > 0) {
    inactiveSectionLabel.style.display = 'block';
    inactiveSectionLabel.textContent = `调度长廊 (${corridorTabs.length})`;

    // Map existing cards by tabId
    const existingCards = new Map();
    stagesList.querySelectorAll('.sm-stage-group').forEach(el => {
      existingCards.set(Number(el.dataset.tabId), el);
    });

    const fragment = document.createDocumentFragment();

    for (const tab of corridorTabs) {
      const isActive = tab.id === activeTabId;
      const expectedType = isActive ? 'active-bar' : 'thumbnail-card';
      let cardEl = existingCards.get(tab.id);

      if (cardEl && cardEl.dataset.cardType === expectedType) {
        // Reuse existing node of same type!
        existingCards.delete(tab.id);
        if (isActive) {
          updateActiveBarCard(cardEl, tab);
        } else {
          updateInactiveTabCard(cardEl, tab);
        }
      } else {
        // If type changed (e.g. was thumbnail, now became active horizontal bar; or vice versa)
        if (cardEl) {
          existingCards.delete(tab.id);
          cardEl.remove();
        }
        if (isActive) {
          cardEl = createActiveBarCard(tab);
        } else {
          cardEl = createInactiveTabCard(tab);
        }
      }
      fragment.appendChild(cardEl);
    }

    // Remove stale cards that no longer exist
    for (const [staleId, staleEl] of existingCards) {
      staleEl.remove();
      thumbnailCache.delete(staleId);
    }

    // Append fragment: reorders smoothly without reloading images or flashing
    stagesList.appendChild(fragment);
  } else {
    inactiveSectionLabel.style.display = 'none';
    stagesList.innerHTML = '';
  }

  // 3. Render VS Code style Thumbnail Minimap Rail for Corridor
  renderMinimap(corridorTabs);
}

/**
 * Render Pinned Tabs Grid using Keyed DOM Reconciliation
 * @param {Array<object>} pinnedTabs
 */
function renderPinnedGrid(pinnedTabs) {
  const existingCards = new Map();
  pinnedGrid.querySelectorAll('.sm-pinned-card').forEach(el => {
    existingCards.set(Number(el.dataset.tabId), el);
  });

  const fragment = document.createDocumentFragment();

  for (const tab of pinnedTabs) {
    let cardEl;
    if (existingCards.has(tab.id)) {
      cardEl = existingCards.get(tab.id);
      existingCards.delete(tab.id);
      updatePinnedCard(cardEl, tab);
    } else {
      cardEl = createPinnedCard(tab);
    }
    fragment.appendChild(cardEl);
  }

  // Remove stale cards that no longer exist
  for (const [staleId, staleEl] of existingCards) {
    staleEl.remove();
  }

  pinnedGrid.appendChild(fragment);
}

/**
 * Create a Square Adaptive Pinned Tab Card
 * @param {object} tab
 * @returns {HTMLElement}
 */
function createPinnedCard(tab) {
  const card = document.createElement('div');
  const isActive = tab.id === activeTabId;
  card.className = `sm-pinned-card${isActive ? ' is-active' : ''}${tab.discarded ? ' is-discarded' : ''}`;
  card.dataset.tabId = tab.id;
  card.title = tab.title || '固定标签页';

  // Card Preview Area (for inactive thumbnail)
  const preview = document.createElement('div');
  preview.className = 'sm-pinned-preview';
  card.appendChild(preview);

  // Footer Overlay with Favicon and Title (for inactive thumbnail)
  const footer = document.createElement('div');
  footer.className = 'sm-pinned-footer';

  const fav = document.createElement('img');
  fav.className = 'sm-pinned-fav';
  fav.src = tab.favIconUrl || getFallbackFavicon(tab.url);
  fav.onerror = () => { fav.src = getFallbackFavicon(tab.url); };

  const name = document.createElement('span');
  name.className = 'sm-pinned-name';
  name.textContent = tab.title || '新标签页';

  footer.appendChild(fav);
  footer.appendChild(name);
  card.appendChild(footer);

  // Active state icon view (Requirement: "当固定的标签页被激活后，显示图标就行了，不然激活的固定标签会一直刷新缩略图")
  const activeContent = document.createElement('div');
  activeContent.className = 'sm-pinned-active-content';
  const activeFav = document.createElement('img');
  activeFav.className = 'sm-pinned-active-fav';
  activeFav.src = tab.favIconUrl || getFallbackFavicon(tab.url);
  activeFav.onerror = () => { activeFav.src = getFallbackFavicon(tab.url); };
  activeContent.appendChild(activeFav);
  card.appendChild(activeContent);

  // Click to activate
  card.onclick = (e) => {
    e.stopPropagation();
    chrome.tabs.update(tab.id, { active: true });
  };

  // Middle-click to close
  card.onauxclick = (e) => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      chrome.tabs.remove(tab.id);
    }
  };

  // Audio indicator (sound playing / muted)
  updatePinnedCardAudio(card, tab);

  // Right-click context menu
  card.oncontextmenu = (e) => showContextMenu(e, tab);

  // If inactive, load thumbnail preview; if active, only show icon (no thumbnail)
  if (!isActive) {
    updatePinnedCardPreview(card, tab);
  }
  return card;
}

/**
 * Update an existing Pinned Tab Card in-place
 * @param {HTMLElement} cardEl
 * @param {object} tab
 */
function updatePinnedCard(cardEl, tab) {
  cardEl.oncontextmenu = (e) => showContextMenu(e, tab);
  const isActive = tab.id === activeTabId;
  if (isActive) {
    cardEl.classList.add('is-active');
  } else {
    cardEl.classList.remove('is-active');
  }

  if (tab.discarded) {
    cardEl.classList.add('is-discarded');
  } else {
    cardEl.classList.remove('is-discarded');
  }

  cardEl.title = tab.title || '固定标签页';

  // Update active icon view
  let activeFav = cardEl.querySelector('.sm-pinned-active-fav');
  const expectedFav = tab.favIconUrl || getFallbackFavicon(tab.url);
  if (!activeFav) {
    let activeContent = cardEl.querySelector('.sm-pinned-active-content');
    if (!activeContent) {
      activeContent = document.createElement('div');
      activeContent.className = 'sm-pinned-active-content';
      cardEl.appendChild(activeContent);
    }
    activeFav = document.createElement('img');
    activeFav.className = 'sm-pinned-active-fav';
    activeFav.onerror = () => { activeFav.src = getFallbackFavicon(tab.url); };
    activeContent.appendChild(activeFav);
  }
  if (activeFav.src !== expectedFav) {
    activeFav.src = expectedFav;
  }

  const nameEl = cardEl.querySelector('.sm-pinned-name');
  if (nameEl && nameEl.textContent !== (tab.title || '新标签页')) {
    nameEl.textContent = tab.title || '新标签页';
  }

  const favEl = cardEl.querySelector('.sm-pinned-fav');
  if (favEl && favEl.src !== expectedFav) {
    favEl.src = expectedFav;
  }

  // Update audio indicator
  updatePinnedCardAudio(cardEl, tab);

  // Requirement: "当固定的标签页被激活后，显示图标就行了，不然激活的固定标签会一直刷新缩略图"
  // If active, do NOT touch or render thumbnail preview!
  if (!isActive) {
    updatePinnedCardPreview(cardEl, tab);
  }
}

/**
 * Update audio playing / muted status indicator for pinned card
 * @param {HTMLElement} cardEl
 * @param {object} tab
 */
function updatePinnedCardAudio(cardEl, tab) {
  let audioBtn = cardEl.querySelector('.sm-pinned-audio');
  const isAudible = Boolean(tab.audible);
  const isMuted = Boolean(tab.mutedInfo && tab.mutedInfo.muted);

  if (isAudible || isMuted) {
    if (!audioBtn) {
      audioBtn = document.createElement('div');
      audioBtn.className = 'sm-pinned-audio';
      cardEl.appendChild(audioBtn);
    }

    if (isMuted) {
      audioBtn.className = 'sm-pinned-audio is-muted';
      audioBtn.title = '取消静音 (网页已静音)';
      audioBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
    } else {
      audioBtn.className = 'sm-pinned-audio is-playing';
      audioBtn.title = '静音此标签页 (正在播放声音)';
      audioBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';
    }

    audioBtn.onclick = (e) => {
      e.stopPropagation();
      chrome.tabs.update(tab.id, { muted: !isMuted });
    };
  } else if (audioBtn) {
    audioBtn.remove();
  }
}

/**
 * Update Pinned Card thumbnail preview
 * @param {HTMLElement} cardEl
 * @param {object} tab
 */
function updatePinnedCardPreview(cardEl, tab) {
  const previewEl = cardEl.querySelector('.sm-pinned-preview');
  if (!previewEl) return;

  const normUrl = normalizeUrl(tab.url);
  const currentRenderedUrl = previewEl.dataset.renderedUrl;

  // Requirement: "顶部固定的缩略图，在当前前台的标签页不应该持续刷新的"
  // If this tab is the active foreground tab and already has a rendered thumbnail for this URL,
  // DO NOT continuously refresh or re-flash it while actively viewing!
  if (tab.id === activeTabId && currentRenderedUrl === normUrl) {
    return;
  }

  if (currentRenderedUrl && currentRenderedUrl !== normUrl) {
    renderPinnedPlaceholder(previewEl, tab);
  }

  const cached = thumbnailCache.get(tab.id);
  if (cached && cached.url === normUrl && cached.dataUrl) {
    if (previewEl.dataset.renderedUrl !== normUrl) {
      previewEl.dataset.renderedUrl = normUrl;
      previewEl.innerHTML = '';
      const img = document.createElement('img');
      img.className = 'sm-pinned-img';
      img.src = cached.dataUrl;
      img.alt = tab.title || '';
      previewEl.appendChild(img);
    }
    return;
  }

  if (!previewEl.dataset.renderedUrl) {
    renderPinnedPlaceholder(previewEl, tab);

    getThumbnail(tab.id, tab.url).then((storedDataUrl) => {
      if (storedDataUrl) {
        const currentTab = allTabs.find(t => t.id === tab.id);
        if (currentTab && normalizeUrl(currentTab.url) === normUrl) {
          thumbnailCache.set(tab.id, { url: normUrl, dataUrl: storedDataUrl });
          previewEl.dataset.renderedUrl = normUrl;
          previewEl.innerHTML = '';
          const img = document.createElement('img');
          img.className = 'sm-pinned-img';
          img.src = storedDataUrl;
          img.alt = tab.title || '';
          previewEl.appendChild(img);
        }
      }
    });
  }
}

/**
 * Render placeholder for pinned square thumbnail
 * @param {HTMLElement} previewEl
 * @param {object} tab
 */
function renderPinnedPlaceholder(previewEl, tab) {
  delete previewEl.dataset.renderedUrl;
  previewEl.innerHTML = '';
  const ph = document.createElement('div');
  ph.className = 'sm-pinned-placeholder';
  const fav = document.createElement('img');
  fav.className = 'sm-pinned-placeholder-fav';
  fav.src = tab.favIconUrl || getFallbackFavicon(tab.url);
  fav.onerror = () => { fav.src = getFallbackFavicon(tab.url); };
  ph.appendChild(fav);
  previewEl.appendChild(ph);
}

/**
 * Create a Horizontal Title Bar for the Active Tab (WITHOUT Thumbnail)
 * Requirement: "当被点击的缩略图的标题激活后，这个缩略图是该消失，然后变成一个横条的形式，显示被激活的标题，不带缩略图的"
 * @param {object} tab
 * @returns {HTMLElement}
 */
function createActiveBarCard(tab) {
  const group = document.createElement('div');
  group.className = 'sm-stage-group is-active-bar';
  group.dataset.tabId = tab.id;
  group.dataset.cardType = 'active-bar';

  const bar = document.createElement('div');
  bar.className = 'sm-active-bar';

  // Left Active Glow Indicator
  const indicator = document.createElement('div');
  indicator.className = 'sm-active-indicator';

  // Favicon
  const fav = document.createElement('img');
  fav.className = 'sm-active-fav';
  fav.src = tab.favIconUrl || getFallbackFavicon(tab.url);
  fav.onerror = () => { fav.src = getFallbackFavicon(tab.url); };

  // Title
  const title = document.createElement('span');
  title.className = 'sm-active-title';
  title.textContent = tab.title || '当前网页';
  title.title = tab.title || '当前网页';

  // Domain Badge
  const domain = document.createElement('span');
  domain.className = 'sm-active-domain';
  domain.textContent = extractDomain(tab.url);

  // Close Button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'sm-active-close';
  closeBtn.title = '关闭此标签页';
  closeBtn.innerHTML = '&times;';
  closeBtn.onclick = (e) => {
    e.stopPropagation();
    chrome.tabs.remove(tab.id);
  };

  bar.appendChild(indicator);
  bar.appendChild(fav);
  bar.appendChild(title);
  if (domain.textContent) {
    bar.appendChild(domain);
  }
  bar.appendChild(closeBtn);
  group.appendChild(bar);

  // Click to focus
  group.onclick = (e) => {
    e.stopPropagation();
    chrome.tabs.update(tab.id, { active: true });
  };

  // Middle-click to close
  group.onauxclick = (e) => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      chrome.tabs.remove(tab.id);
    }
  };

  // Right-click context menu
  group.oncontextmenu = (e) => showContextMenu(e, tab);

  return group;
}

/**
 * Update an existing Active Horizontal Bar
 * @param {HTMLElement} cardEl
 * @param {object} tab
 */
function updateActiveBarCard(cardEl, tab) {
  cardEl.dataset.tabId = tab.id;
  cardEl.dataset.cardType = 'active-bar';
  cardEl.oncontextmenu = (e) => showContextMenu(e, tab);

  const titleEl = cardEl.querySelector('.sm-active-title');
  if (titleEl && titleEl.textContent !== (tab.title || '当前网页')) {
    titleEl.textContent = tab.title || '当前网页';
    titleEl.title = tab.title || '当前网页';
  }

  const domainEl = cardEl.querySelector('.sm-active-domain');
  const d = extractDomain(tab.url);
  if (domainEl && domainEl.textContent !== d) {
    domainEl.textContent = d;
  }

  const favEl = cardEl.querySelector('.sm-active-fav');
  const expectedFav = tab.favIconUrl || getFallbackFavicon(tab.url);
  if (favEl && favEl.src !== expectedFav) {
    favEl.src = expectedFav;
  }
}

/**
 * Update an existing Inactive Card in-place (Zero-Flicker & URL-Safe)
 * @param {HTMLElement} cardEl
 * @param {object} tab
 */
function updateInactiveTabCard(cardEl, tab) {
  cardEl.dataset.tabId = tab.id;
  cardEl.dataset.cardType = 'thumbnail-card';
  cardEl.oncontextmenu = (e) => showContextMenu(e, tab);
  // Update discarded class
  if (tab.discarded) {
    cardEl.classList.add('is-discarded');
  } else {
    cardEl.classList.remove('is-discarded');
  }

  // Update title if changed
  const titleEl = cardEl.querySelector('.sm-card-title');
  const expectedTitle = tab.title || '新标签页';
  if (titleEl && titleEl.textContent !== expectedTitle) {
    titleEl.textContent = expectedTitle;
    titleEl.title = expectedTitle;
  }

  // Update favicon if changed
  const faviconEl = cardEl.querySelector('.sm-card-favicon');
  const expectedFavicon = tab.favIconUrl || getFallbackFavicon(tab.url);
  if (faviconEl && faviconEl.src !== expectedFavicon) {
    faviconEl.src = expectedFavicon;
  }

  // Update sleeping badge
  const infoEl = cardEl.querySelector('.sm-card-info');
  let badgeEl = cardEl.querySelector('.sm-sleeping-badge');
  if (tab.discarded && !badgeEl && infoEl) {
    badgeEl = document.createElement('span');
    badgeEl.className = 'sm-sleeping-badge';
    badgeEl.title = '该标签已处于内存休眠状态，点击即刻唤醒';
    badgeEl.textContent = '💤 休眠';
    infoEl.appendChild(badgeEl);
  } else if (!tab.discarded && badgeEl) {
    badgeEl.remove();
  }

  // Update preview image with strict URL validation
  updateInactiveTabPreview(cardEl, tab);
}

/**
 * Create Inactive Tab Card (with 3D perspective and live thumbnail)
 * @param {object} tab
 */
function createInactiveTabCard(tab) {
  const container = document.createElement('div');
  container.className = 'sm-stage-group';
  container.dataset.tabId = tab.id;
  container.dataset.cardType = 'thumbnail-card';

  // Sleeping / Discarded tab indicator
  if (tab.discarded) {
    container.classList.add('is-discarded');
  }

  // Middle-click on card to quickly close tab
  container.onauxclick = (e) => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      chrome.tabs.remove(tab.id);
    }
  };

  const cardWrapper = document.createElement('div');
  cardWrapper.className = 'sm-card-wrapper';

  const card = document.createElement('div');
  card.className = 'sm-card';

  // Card Header
  const header = document.createElement('div');
  header.className = 'sm-card-header';

  const info = document.createElement('div');
  info.className = 'sm-card-info';

  const favicon = document.createElement('img');
  favicon.className = 'sm-card-favicon';
  favicon.src = tab.favIconUrl || getFallbackFavicon(tab.url);
  favicon.onerror = () => {
    favicon.src = getFallbackFavicon(tab.url);
  };

  const title = document.createElement('span');
  title.className = 'sm-card-title';
  title.textContent = tab.title || '新标签页';
  title.title = tab.title || '';

  info.appendChild(favicon);
  info.appendChild(title);

  // Sleeping badge if tab is discarded
  if (tab.discarded) {
    const sleepBadge = document.createElement('span');
    sleepBadge.className = 'sm-sleeping-badge';
    sleepBadge.title = '该标签已处于内存休眠状态，点击即刻唤醒';
    sleepBadge.textContent = '💤 休眠';
    info.appendChild(sleepBadge);
  }

  const controls = document.createElement('div');
  controls.className = 'sm-card-controls';

  // Audio indicator
  if (tab.audible) {
    const audioBtn = document.createElement('div');
    audioBtn.className = 'sm-card-audio';
    audioBtn.title = tab.mutedInfo?.muted ? '取消静音' : '静音标签';
    audioBtn.innerHTML = tab.mutedInfo?.muted
      ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
      : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';
    audioBtn.onclick = (e) => {
      e.stopPropagation();
      chrome.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
    };
    controls.appendChild(audioBtn);
  }

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'sm-card-close';
  closeBtn.innerHTML = '&times;';
  closeBtn.title = '关闭标签 (中键也可关闭)';
  closeBtn.onclick = (e) => {
    e.stopPropagation();
    chrome.tabs.remove(tab.id);
  };
  controls.appendChild(closeBtn);

  header.appendChild(info);
  header.appendChild(controls);

  // Card Preview Body
  const preview = document.createElement('div');
  preview.className = 'sm-card-preview';
  preview.id = `preview-${tab.id}`;

  card.appendChild(header);
  card.appendChild(preview);
  cardWrapper.appendChild(card);
  container.appendChild(cardWrapper);

  // Strictly update preview image
  updateInactiveTabPreview(card, tab);

  // Click to activate this tab
  container.onclick = () => {
    chrome.tabs.update(tab.id, { active: true });
  };

  // Right-click context menu
  container.oncontextmenu = (e) => showContextMenu(e, tab);

  return container;
}

/**
 * Strict URL-validated preview updater
 * Guarantees that a card NEVER displays an image from a different URL!
 * @param {HTMLElement} cardEl
 * @param {object} tab
 */
function updateInactiveTabPreview(cardEl, tab) {
  const previewEl = cardEl.querySelector('.sm-card-preview');
  if (!previewEl) return;

  const normUrl = normalizeUrl(tab.url);
  const currentRenderedUrl = previewEl.dataset.renderedUrl;

  // 1. If the tab navigated away from what's currently rendered, immediately clear and reset to placeholder!
  if (currentRenderedUrl && currentRenderedUrl !== normUrl) {
    renderPlaceholder(previewEl, tab);
  }

  // 2. Synchronous check: Memory Cache
  const cached = thumbnailCache.get(tab.id);
  if (cached && cached.url === normUrl) {
    if (previewEl.dataset.renderedUrl !== normUrl) {
      updatePreviewImage(previewEl, cached.dataUrl, normUrl, tab.title);
    }
    return;
  }

  // 3. Fallback: If not in memory and nothing currently rendered, render placeholder first
  if (!previewEl.dataset.renderedUrl) {
    renderPlaceholder(previewEl, tab);

    // 4. Asynchronously query IndexedDB strictly validating URL
    getThumbnail(tab.id, tab.url).then((storedDataUrl) => {
      if (storedDataUrl) {
        // Verify that the tab didn't navigate while reading from IndexedDB
        const currentTab = allTabs.find(t => t.id === tab.id);
        if (currentTab && normalizeUrl(currentTab.url) === normUrl) {
          thumbnailCache.set(tab.id, { url: normUrl, dataUrl: storedDataUrl });
          updatePreviewImage(previewEl, storedDataUrl, normUrl, currentTab.title);
          if (minimapTrack) {
            const miniCardEl = minimapTrack.querySelector(`[data-tab-id="${tab.id}"]`);
            if (miniCardEl) {
              updateMiniCardContent(miniCardEl, currentTab);
            }
          }
        }
      }
    });
  }
}

/**
 * Smoothly update preview image without deadlock or flashing
 * @param {HTMLElement} previewEl
 * @param {string} dataUrl
 * @param {string} url
 * @param {string} title
 */
function updatePreviewImage(previewEl, dataUrl, url, title = '') {
  if (!previewEl || !dataUrl) return;

  previewEl.dataset.renderedUrl = url;
  const existingImg = previewEl.querySelector('img');
  if (existingImg) {
    if (existingImg.src !== dataUrl) {
      existingImg.src = dataUrl;
    }
    existingImg.alt = title || '';
    return;
  }

  // Directly swap into the DOM
  previewEl.innerHTML = '';
  const img = document.createElement('img');
  img.alt = title || '';
  img.src = dataUrl;
  previewEl.appendChild(img);
}

/**
 * Render elegant placeholder card
 * @param {HTMLElement} previewEl
 * @param {object} tab
 */
function renderPlaceholder(previewEl, tab) {
  delete previewEl.dataset.renderedUrl;
  previewEl.innerHTML = '';
  const placeholder = document.createElement('div');
  placeholder.className = 'sm-card-placeholder';

  const icon = document.createElement('img');
  icon.className = 'placeholder-icon';
  icon.src = tab.favIconUrl || getFallbackFavicon(tab.url);
  icon.onerror = () => {
    icon.style.display = 'none';
  };

  const domain = document.createElement('div');
  domain.className = 'placeholder-domain';
  domain.textContent = extractDomain(tab.url) || tab.title || '新标签页';

  placeholder.appendChild(icon);
  placeholder.appendChild(domain);
  previewEl.appendChild(placeholder);
}

/**
 * Setup Event Listeners
 */
function setupEventListeners() {
  // Listen to background service worker messages (live thumbnail updates)
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'THUMBNAIL_UPDATED') {
      const tabId = Number(message.tabId);
      const messageUrl = normalizeUrl(message.url);

      // Verify that this tab still has this exact URL in current window
      const currentTab = allTabs.find(t => t.id === tabId);
      if (!currentTab || normalizeUrl(currentTab.url) !== messageUrl) {
        Logger.warn('SidePanel', `忽略失效缩略图广播: Tab ${tabId}`);
        return;
      }

      thumbnailCache.set(tabId, {
        url: messageUrl,
        dataUrl: message.dataUrl
      });

      // 1. If pinned tab: update pinned card thumbnail
      // REQUIREMENT: "当固定的标签页被激活后，显示图标就行了，不然激活的固定标签会一直刷新缩略图"
      if (currentTab.pinned && pinnedGrid) {
        // If this tab is the active tab, it only shows the icon - do NOT update or touch thumbnail!
        if (tabId === activeTabId) {
          return;
        }
        const pinnedCardEl = pinnedGrid.querySelector(`[data-tab-id="${tabId}"]`);
        if (pinnedCardEl) {
          updatePinnedCardPreview(pinnedCardEl, currentTab);
        }
      }

      // 2. If corridor tab: update corridor card thumbnail
      const cardEl = stagesList.querySelector(`[data-tab-id="${tabId}"]`);
      if (cardEl) {
        const previewEl = cardEl.querySelector('.sm-card-preview');
        if (previewEl) {
          updatePreviewImage(previewEl, message.dataUrl, messageUrl, currentTab.title);
        }
      }

      // 3. Minimap update:
      // REQUIREMENT: "缩略图目录应该不持续刷新当前正在看的网页缩略图"
      // If this thumbnail belongs to the currently active tab being viewed, DO NOT re-render the minimap!
      if (tabId === activeTabId) {
        return;
      }

      // Update Minimap Micro Card preview for inactive tabs
      if (minimapTrack) {
        const miniCardEl = minimapTrack.querySelector(`[data-tab-id="${tabId}"]`);
        if (miniCardEl) {
          updateMiniCardContent(miniCardEl, currentTab);
        }
      }

      // Update Popover preview if hovering this tab
      if (activePopoverTabId === tabId && popoverPreview) {
        popoverPreview.innerHTML = `<img class="sm-popover-img" src="${message.dataUrl}" alt="">`;
      }
    }
  });

  // Chrome Tabs listeners (All debounced via scheduleRefresh)
  chrome.tabs.onActivated.addListener((activeInfo) => {
    if (activeInfo.windowId === currentWindowId) {
      activeTabId = activeInfo.tabId;
      scheduleRefresh();
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tab.windowId === currentWindowId) {
      if (changeInfo.url) {
        // Tab navigated: purge memory cache for this tab so it doesn't show previous site
        thumbnailCache.delete(tabId);
      }
      if (
        changeInfo.status === 'complete' ||
        changeInfo.title ||
        changeInfo.favIconUrl ||
        changeInfo.url ||
        changeInfo.audible !== undefined ||
        changeInfo.mutedInfo !== undefined ||
        changeInfo.discarded !== undefined
      ) {
        scheduleRefresh();
      }
    }
  });

  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (removeInfo.windowId === currentWindowId) {
      thumbnailCache.delete(tabId);
      scheduleRefresh();
    }
  });

  chrome.tabs.onMoved.addListener(() => scheduleRefresh());
  chrome.tabs.onDetached.addListener(() => scheduleRefresh());
  chrome.tabs.onAttached.addListener(() => scheduleRefresh());

  // New Tab button
  if (btnNewTab) {
    btnNewTab.addEventListener('click', () => {
      chrome.tabs.create({});
    });
  }

  // Toggle Search
  if (btnSearchToggle) {
    btnSearchToggle.addEventListener('click', () => {
      if (!searchBar) return;
      const isHidden = searchBar.style.display === 'none';
      searchBar.style.display = isHidden ? 'flex' : 'none';
      if (isHidden && searchInput) {
        searchInput.focus();
      } else {
        searchQuery = '';
        if (searchInput) searchInput.value = '';
        if (searchClear) searchClear.style.display = 'none';
        render();
      }
    });
  }

  // Search input handler
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      if (searchClear) searchClear.style.display = searchQuery ? 'block' : 'none';
      render();
    });
  }

  if (searchClear) {
    searchClear.addEventListener('click', () => {
      searchQuery = '';
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
      searchClear.style.display = 'none';
      render();
    });
  }

  // Global search shortcut (Ctrl+K / Cmd+K) and Escape
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      if (btnSearchToggle) {
        e.preventDefault();
        btnSearchToggle.click();
      }
    } else if (e.key === 'Escape') {
      if (searchBar && searchBar.style.display !== 'none') {
        searchBar.style.display = 'none';
        searchQuery = '';
        if (searchInput) searchInput.value = '';
        render();
      }
      if (logsDrawer && logsDrawer.style.display !== 'none') {
        logsDrawer.style.display = 'none';
      }
    }
  });

  // Forward wheel scroll on fixed pinned section to corridor when pinned section doesn't overflow
  if (pinnedStageSection) {
    pinnedStageSection.addEventListener('wheel', (e) => {
      if (pinnedStageSection.scrollHeight <= pinnedStageSection.clientHeight) {
        stageCorridor.scrollTop += e.deltaY;
      }
    }, { passive: true });
  }
}

/**
 * Diagnostic Logs Drawer Setup
 */
function setupDiagnosticDrawer() {
  // Toggle Drawer
  if (btnLogsToggle) {
    btnLogsToggle.addEventListener('click', () => {
      const isHidden = logsDrawer.style.display === 'none';
      logsDrawer.style.display = isHidden ? 'flex' : 'none';
      if (isHidden) {
        renderLogEntries();
      }
    });
  }

  // Close Drawer
  btnCloseLogs.addEventListener('click', () => {
    logsDrawer.style.display = 'none';
  });

  // Real-time listener for incoming log entries
  window.__onStageManagerLog = (entry) => {
    if (logsDrawer.style.display !== 'none') {
      appendLogEntry(entry);
    }
    updateLogsCount();
  };

  window.__onStageManagerLogClear = () => {
    logsContent.innerHTML = '';
    updateLogsCount();
  };

  // Copy Logs to Clipboard
  btnCopyLogs.addEventListener('click', () => {
    const logs = Logger.getLogs();
    const text = logs.map(l => `[${l.time}] [${l.level}] [${l.tag}] ${l.message} ${l.details || ''}`).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      const orig = btnCopyLogs.textContent;
      btnCopyLogs.textContent = '已复制!';
      setTimeout(() => { btnCopyLogs.textContent = orig; }, 1500);
    }).catch(err => {
      Logger.error('SidePanel', '复制日志失败:', err);
    });
  });

  // Clear Logs
  btnClearLogs.addEventListener('click', () => {
    Logger.clearLogs();
  });

  // Clean Stale Cache
  btnCleanDb.addEventListener('click', async () => {
    const orig = btnCleanDb.textContent;
    btnCleanDb.textContent = '清理中...';
    thumbnailCache.clear();
    await chrome.runtime.sendMessage({ type: 'CLEAR_ALL_DATA' }).catch(() => {});
    render();
    btnCleanDb.textContent = '已清理';
    setTimeout(() => { btnCleanDb.textContent = orig; }, 1500);
    Logger.info('SidePanel', '已清空并重建缩略图缓存');
  });

  updateLogsCount();
}

function updateLogsCount() {
  const count = Logger.getLogs().length;
  logsCountEl.textContent = count;
}

function renderLogEntries() {
  logsContent.innerHTML = '';
  const entries = Logger.getLogs();
  for (const entry of entries) {
    appendLogEntry(entry);
  }
  logsContent.scrollTop = logsContent.scrollHeight;
}

function appendLogEntry(entry) {
  const item = document.createElement('div');
  item.className = 'sm-log-item';

  const time = document.createElement('span');
  time.className = 'sm-log-time';
  time.textContent = entry.time;

  const tag = document.createElement('span');
  tag.className = 'sm-log-tag';
  tag.textContent = `[${entry.tag}]`;

  const msg = document.createElement('span');
  msg.className = `sm-log-msg sm-log-${entry.level}`;
  msg.textContent = entry.message + (entry.details ? ` (${entry.details})` : '');

  item.appendChild(time);
  item.appendChild(tag);
  item.appendChild(msg);

  logsContent.appendChild(item);
  logsContent.scrollTop = logsContent.scrollHeight;
}

/**
 * =========================================================
 * Custom Right-Click Context Menu
 * =========================================================
 */

/**
 * Show custom context menu for a specific tab
 * @param {MouseEvent} e
 * @param {object} tab
 */
function showContextMenu(e, tab) {
  e.preventDefault();
  e.stopPropagation();

  if (!tabContextMenu) return;
  contextMenuTargetTab = tab;

  // 1. Split screen (native 50/50 dual pane)
  // 2. Pin / Unpin tab dynamic text
  const pinBtn = document.getElementById('ctx-pin-tab');
  if (pinBtn) {
    const pinText = pinBtn.querySelector('.sm-ctx-text');
    if (pinText) {
      pinText.textContent = tab.pinned ? '取消固定标签' : '固定标签';
    }
  }

  // 3. Close other tabs & Close tabs below availability check
  const closeOthersBtn = document.getElementById('ctx-close-others');
  const closeBelowBtn = document.getElementById('ctx-close-below');

  const currentWindowTabs = allTabs.filter(t => t.windowId === (tab.windowId || currentWindowId));
  const unpinnedTabs = currentWindowTabs.filter(t => !t.pinned);

  // Can close other tabs if there are other unpinned tabs
  const otherUnpinned = unpinnedTabs.filter(t => t.id !== tab.id);
  if (closeOthersBtn) {
    if (otherUnpinned.length > 0) {
      closeOthersBtn.classList.remove('is-disabled');
    } else {
      closeOthersBtn.classList.add('is-disabled');
    }
  }

  // Can close below if there are unpinned tabs with index > tab.index
  if (closeBelowBtn) {
    const tabsBelow = unpinnedTabs.filter(t => t.index > tab.index);
    if (tabsBelow.length > 0) {
      closeBelowBtn.classList.remove('is-disabled');
    } else {
      closeBelowBtn.classList.add('is-disabled');
    }
  }

  // 4. Mute / Unmute site dynamic text
  const muteBtn = document.getElementById('ctx-mute-site');
  if (muteBtn) {
    const isMuted = Boolean(tab.mutedInfo && tab.mutedInfo.muted);
    const muteText = muteBtn.querySelector('.sm-ctx-text');
    if (muteText) {
      muteText.textContent = isMuted ? '取消网站静音' : '将网站静音';
    }
  }

  // Position and display menu
  tabContextMenu.style.display = 'block';
  tabContextMenu.style.visibility = 'hidden';

  const menuWidth = tabContextMenu.offsetWidth || 150;
  const menuHeight = tabContextMenu.offsetHeight || 190;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let x = e.clientX;
  let y = e.clientY;

  // Boundary checks to prevent overflowing outside the side panel viewport
  if (x + menuWidth > viewportWidth - 8) {
    x = Math.max(8, viewportWidth - menuWidth - 8);
  }
  if (y + menuHeight > viewportHeight - 8) {
    y = Math.max(8, viewportHeight - menuHeight - 8);
  }

  tabContextMenu.style.left = `${x}px`;
  tabContextMenu.style.top = `${y}px`;
  tabContextMenu.style.visibility = 'visible';
}

/**
 * Dismiss context menu
 */
function hideContextMenu() {
  if (tabContextMenu && tabContextMenu.style.display !== 'none') {
    tabContextMenu.style.display = 'none';
    contextMenuTargetTab = null;
  }
}

/**
 * Setup interactions for Context Menu actions & auto-dismissal
 */
function setupContextMenuInteractions() {
  if (!tabContextMenu) return;

  // 1. Browser Native Split Screen (Single-window side-by-side tab split view)
  const splitBtn = document.getElementById('ctx-split-screen');
  if (splitBtn) {
    splitBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!contextMenuTargetTab) return;
      const targetTab = contextMenuTargetTab;
      hideContextMenu();

      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

        // 1. Use Chromium Tabs Split View API: chrome.tabs.createSplit([firstId, secondId])
        if (typeof chrome.tabs.createSplit === 'function') {
          let firstId = activeTab ? activeTab.id : null;
          let secondId = targetTab.id;

          if (firstId === secondId) {
            // Clicked active tab itself: find adjacent tab to pair with, or create new split tab
            const currentTabs = await chrome.tabs.query({ currentWindow: true });
            const adjacent = currentTabs.find(t => t.id !== targetTab.id && Math.abs(t.index - targetTab.index) === 1);
            if (adjacent) {
              secondId = adjacent.id;
            } else if (typeof chrome.tabs.create === 'function') {
              await chrome.tabs.create({ splitWithTabId: targetTab.id });
              Logger.info('SidePanel', `浏览器原生分屏成功 (新建并排标签): Tab [${targetTab.title}]`);
              return;
            }
          }

          if (firstId && secondId && firstId !== secondId) {
            const currentTabs = await chrome.tabs.query({ currentWindow: true });
            const t1 = currentTabs.find(t => t.id === firstId);
            const t2 = currentTabs.find(t => t.id === secondId);

            if (t1 && t2) {
              // Constraint 1: Matching pinned states
              if (t1.pinned !== t2.pinned) {
                await chrome.tabs.update(t2.id, { pinned: t1.pinned });
              }

              // Constraint 2: Adjacent tab indices
              const freshTabs = await chrome.tabs.query({ currentWindow: true });
              const freshT1 = freshTabs.find(t => t.id === firstId);
              const freshT2 = freshTabs.find(t => t.id === secondId);

              if (freshT1 && freshT2 && Math.abs(freshT1.index - freshT2.index) !== 1) {
                const targetIndex = freshT1.index < freshT2.index ? freshT1.index + 1 : freshT1.index;
                await chrome.tabs.move(freshT2.id, { index: targetIndex });
              }

              // Constraint 3: Unsplit if already split
              if (typeof chrome.tabs.unsplit === 'function') {
                if (t1.splitViewId && t1.splitViewId !== -1) {
                  try { await chrome.tabs.unsplit(t1.splitViewId); } catch (e) {}
                }
                if (t2.splitViewId && t2.splitViewId !== -1) {
                  try { await chrome.tabs.unsplit(t2.splitViewId); } catch (e) {}
                }
              }

              await chrome.tabs.createSplit([firstId, secondId]);
              Logger.info('SidePanel', `浏览器原生单窗口分屏成功: Tab [${t1.title}] + Tab [${t2.title}]`);
              return;
            }
          }
        }

        // 2. Fallback: Try chrome.tabs.create with splitWithTabId
        if (activeTab && activeTab.id !== targetTab.id) {
          try {
            await chrome.tabs.create({ url: targetTab.url, splitWithTabId: activeTab.id });
            await chrome.tabs.remove(targetTab.id);
            Logger.info('SidePanel', `通过 splitWithTabId 原生分屏成功: Tab [${targetTab.title}]`);
            return;
          } catch (e) {
            Logger.warn('SidePanel', 'splitWithTabId 尝试失败:', e);
          }
        }

        // 3. Fallback: If neither API is supported in the current browser runtime
        Logger.warn('SidePanel', '当前浏览器未开放扩展程序直接调用单窗口原生分屏 API (chrome.tabs.createSplit)');
        alert('当前浏览器环境尚未开放扩展直接调用单窗口原生分屏 API。您可以在标签栏右键选择「将标签页添加到新分屏视图」或使用浏览器分屏快捷键。');
      } catch (err) {
        Logger.error('SidePanel', '浏览器原生分屏失败:', err);
      }
    });
  }

  // 2. Pin / Unpin Tab
  const pinBtn = document.getElementById('ctx-pin-tab');
  if (pinBtn) {
    pinBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!contextMenuTargetTab) return;
      const targetTab = contextMenuTargetTab;
      hideContextMenu();
      try {
        await chrome.tabs.update(targetTab.id, { pinned: !targetTab.pinned });
        Logger.info('SidePanel', `${targetTab.pinned ? '取消固定' : '固定'}标签 [${targetTab.title}]`);
      } catch (err) {
        Logger.error('SidePanel', '固定/取消固定标签失败:', err);
      }
    });
  }

  // 3. Open in New Window
  const newWinBtn = document.getElementById('ctx-new-window');
  if (newWinBtn) {
    newWinBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!contextMenuTargetTab) return;
      const targetTab = contextMenuTargetTab;
      hideContextMenu();
      try {
        await chrome.windows.create({
          tabId: targetTab.id,
          focused: true
        });
        Logger.info('SidePanel', `在新窗口打开标签 [${targetTab.title}]`);
      } catch (err) {
        Logger.error('SidePanel', '在新窗口打开失败:', err);
      }
    });
  }

  // 4. Close Other Tabs
  const closeOthersBtn = document.getElementById('ctx-close-others');
  if (closeOthersBtn) {
    closeOthersBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!contextMenuTargetTab || closeOthersBtn.classList.contains('is-disabled')) return;
      const targetTab = contextMenuTargetTab;
      hideContextMenu();
      try {
        const tabs = await chrome.tabs.query({ windowId: targetTab.windowId });
        const toRemove = tabs.filter(t => !t.pinned && t.id !== targetTab.id).map(t => t.id);
        if (toRemove.length > 0) {
          await chrome.tabs.remove(toRemove);
          Logger.info('SidePanel', `已关闭其他 ${toRemove.length} 个标签`);
        }
      } catch (err) {
        Logger.error('SidePanel', '关闭其他标签失败:', err);
      }
    });
  }

  // 5. Close Tabs Below
  const closeBelowBtn = document.getElementById('ctx-close-below');
  if (closeBelowBtn) {
    closeBelowBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!contextMenuTargetTab || closeBelowBtn.classList.contains('is-disabled')) return;
      const targetTab = contextMenuTargetTab;
      hideContextMenu();
      try {
        const tabs = await chrome.tabs.query({ windowId: targetTab.windowId });
        const toRemove = tabs.filter(t => !t.pinned && t.index > targetTab.index).map(t => t.id);
        if (toRemove.length > 0) {
          await chrome.tabs.remove(toRemove);
          Logger.info('SidePanel', `已关闭下方 ${toRemove.length} 个标签`);
        }
      } catch (err) {
        Logger.error('SidePanel', '关闭下方标签失败:', err);
      }
    });
  }

  // 6. Mute / Unmute Site
  const muteBtn = document.getElementById('ctx-mute-site');
  if (muteBtn) {
    muteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!contextMenuTargetTab) return;
      const targetTab = contextMenuTargetTab;
      hideContextMenu();
      try {
        const isMuted = Boolean(targetTab.mutedInfo && targetTab.mutedInfo.muted);
        await chrome.tabs.update(targetTab.id, { muted: !isMuted });
        Logger.info('SidePanel', `${isMuted ? '取消静音' : '静音'}网站 [${targetTab.title}]`);
      } catch (err) {
        Logger.error('SidePanel', '静音/取消静音失败:', err);
      }
    });
  }

  // Dismiss listeners
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#tab-context-menu')) {
      hideContextMenu();
    }
  });

  document.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('[data-tab-id]')) {
      hideContextMenu();
    }
  });

  window.addEventListener('blur', hideContextMenu);
  window.addEventListener('resize', hideContextMenu);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideContextMenu();
    }
  });

  if (stageCorridor) {
    stageCorridor.addEventListener('scroll', hideContextMenu, { passive: true });
  }
}

/**
 * =========================================================
 * VS Code Style Thumbnail Minimap Rail
 * =========================================================
 */

/**
 * Render Minimap using Keyed DOM Reconciliation
 * Mirrors the scrollable Stage Corridor 1:1
 * Active tab renders as a slim horizontal bar (without thumbnail)
 * @param {Array<object>} corridorTabs
 */
function renderMinimap(corridorTabs = []) {
  if (!minimapTrack) return;
  if (!minimapEnabled || smMinimap.classList.contains('is-hidden')) return;

  const existingMiniCards = new Map();
  minimapTrack.querySelectorAll('.sm-mini-card').forEach(el => {
    existingMiniCards.set(Number(el.dataset.tabId), el);
  });

  const fragment = document.createDocumentFragment();

  // Render Corridor Tabs
  if (corridorTabs && corridorTabs.length > 0) {
    for (const tab of corridorTabs) {
      const isActive = tab.id === activeTabId;
      const expectedType = isActive ? 'active-bar' : 'thumbnail-card';
      let miniCard = existingMiniCards.get(tab.id);

      if (miniCard && miniCard.dataset.miniType === expectedType) {
        existingMiniCards.delete(tab.id);
        if (isActive) {
          updateMiniActiveBar(miniCard, tab);
        } else {
          updateMiniCard(miniCard, tab, false);
        }
      } else {
        if (miniCard) {
          existingMiniCards.delete(tab.id);
          miniCard.remove();
        }
        if (isActive) {
          miniCard = createMiniActiveBar(tab);
        } else {
          miniCard = createMiniCard(tab, false);
        }
      }
      fragment.appendChild(miniCard);
    }
  }

  // Remove stale mini cards that no longer exist
  for (const [staleId, staleEl] of existingMiniCards) {
    staleEl.remove();
  }

  minimapTrack.appendChild(fragment);

  // Synchronize slider position & size
  scheduleMinimapSliderUpdate();
}

/**
 * Create a Mini Horizontal Bar in Minimap for Active Tab (NO Thumbnail)
 * Requirement: "目录那边也是要注意这个改动"
 * @param {object} tab
 * @returns {HTMLElement}
 */
function createMiniActiveBar(tab) {
  const card = document.createElement('div');
  card.className = 'sm-mini-card is-active-bar';
  card.dataset.tabId = tab.id;
  card.dataset.miniType = 'active-bar';
  card.title = `${tab.title || '当前网页'} (当前激活)`;

  const bar = document.createElement('div');
  bar.className = 'sm-mini-active-bar';

  const dot = document.createElement('div');
  dot.className = 'sm-mini-active-dot';

  const fav = document.createElement('img');
  fav.className = 'sm-mini-active-fav';
  fav.src = tab.favIconUrl || getFallbackFavicon(tab.url);
  fav.onerror = () => { fav.src = getFallbackFavicon(tab.url); };

  bar.appendChild(dot);
  bar.appendChild(fav);
  card.appendChild(bar);

  // Click to activate / scroll
  card.onclick = (e) => {
    e.stopPropagation();
    scrollCorridorToTab(tab.id);
  };

  // Middle-click to quickly close tab
  card.onauxclick = (e) => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      chrome.tabs.remove(tab.id);
      hideMinimapPopover();
    }
  };

  // Hover Popover (VS Code Glance)
  card.onmouseenter = () => {
    showMinimapPopover(tab, card);
  };

  card.onmouseleave = () => {
    hideMinimapPopover();
  };

  // Right-click context menu
  card.oncontextmenu = (e) => showContextMenu(e, tab);

  return card;
}

/**
 * Update an existing Mini Active Bar
 * @param {HTMLElement} cardEl
 * @param {object} tab
 */
function updateMiniActiveBar(cardEl, tab) {
  cardEl.dataset.tabId = tab.id;
  cardEl.dataset.miniType = 'active-bar';
  cardEl.title = `${tab.title || '当前网页'} (当前激活)`;
  cardEl.oncontextmenu = (e) => showContextMenu(e, tab);

  const fav = cardEl.querySelector('.sm-mini-active-fav');
  const expectedFav = tab.favIconUrl || getFallbackFavicon(tab.url);
  if (fav && fav.src !== expectedFav) {
    fav.src = expectedFav;
  }
}

/**
 * Create a new Mini Card for Minimap
 * @param {object} tab
 * @param {boolean} isActive
 * @returns {HTMLElement}
 */
function createMiniCard(tab, isActive = false) {
  const card = document.createElement('div');
  card.className = `sm-mini-card${isActive ? ' is-active' : ''}${tab.discarded ? ' is-discarded' : ''}`;
  card.dataset.tabId = tab.id;
  card.dataset.miniType = 'thumbnail-card';
  card.title = tab.title || '标签页';

  updateMiniCardContent(card, tab);

  // Click to activate / scroll
  card.onclick = (e) => {
    e.stopPropagation();
    if (!isActive) {
      chrome.tabs.update(tab.id, { active: true });
    }
    scrollCorridorToTab(tab.id);
  };

  // Middle-click to quickly close tab
  card.onauxclick = (e) => {
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      chrome.tabs.remove(tab.id);
      hideMinimapPopover();
    }
  };

  // Hover Popover (VS Code Glance)
  card.onmouseenter = () => {
    showMinimapPopover(tab, card);
  };

  card.onmouseleave = () => {
    hideMinimapPopover();
  };

  // Right-click context menu
  card.oncontextmenu = (e) => showContextMenu(e, tab);

  return card;
}

/**
 * Update an existing Mini Card in-place
 * @param {HTMLElement} cardEl
 * @param {object} tab
 * @param {boolean} isActive
 */
function updateMiniCard(cardEl, tab, isActive = false) {
  cardEl.dataset.tabId = tab.id;
  cardEl.dataset.miniType = 'thumbnail-card';
  cardEl.oncontextmenu = (e) => showContextMenu(e, tab);
  if (isActive) {
    cardEl.classList.add('is-active');
  } else {
    cardEl.classList.remove('is-active');
  }

  if (tab.discarded) {
    cardEl.classList.add('is-discarded');
  } else {
    cardEl.classList.remove('is-discarded');
  }

  cardEl.title = tab.title || '标签页';
  updateMiniCardContent(cardEl, tab);
}

/**
 * Update Mini Card internal graphic content
 * @param {HTMLElement} cardEl
 * @param {object} tab
 */
function updateMiniCardContent(cardEl, tab) {
  const normUrl = normalizeUrl(tab.url);
  const cached = thumbnailCache.get(tab.id);

  // If this tab is the currently active foreground tab:
  // Requirement: "缩略图目录应该不持续刷新当前正在看的网页缩略图"
  // If already rendered, do NOT continuously touch or re-flash it while actively viewing!
  if (tab.id === activeTabId && cardEl.dataset.renderedUrl === normUrl) {
    return;
  }

  if (cached && cached.url === normUrl && cached.dataUrl) {
    cardEl.dataset.renderedUrl = normUrl;
    let img = cardEl.querySelector('.sm-mini-img');
    if (!img) {
      cardEl.innerHTML = '';
      img = document.createElement('img');
      img.className = 'sm-mini-img';
      img.alt = tab.title || '';
      cardEl.appendChild(img);
    }
    if (img.src !== cached.dataUrl) {
      img.src = cached.dataUrl;
    }
  } else {
    delete cardEl.dataset.renderedUrl;
    // Favicon placeholder
    let placeholder = cardEl.querySelector('.sm-mini-placeholder');
    if (!placeholder) {
      cardEl.innerHTML = '';
      placeholder = document.createElement('div');
      placeholder.className = 'sm-mini-placeholder';
      const fav = document.createElement('img');
      fav.className = 'sm-mini-favicon';
      fav.src = tab.favIconUrl || getFallbackFavicon(tab.url);
      fav.onerror = () => { fav.src = getFallbackFavicon(tab.url); };
      placeholder.appendChild(fav);
      cardEl.appendChild(placeholder);
    } else {
      const fav = placeholder.querySelector('.sm-mini-favicon');
      const expectedFav = tab.favIconUrl || getFallbackFavicon(tab.url);
      if (fav && fav.src !== expectedFav) {
        fav.src = expectedFav;
      }
    }
  }
}

/**
 * Smoothly scroll main corridor to corresponding tab card
 * @param {number} tabId
 */
function scrollCorridorToTab(tabId) {
  if (pinnedGrid) {
    const pinnedCard = pinnedGrid.querySelector(`[data-tab-id="${tabId}"]`);
    if (pinnedCard) {
      stageCorridor.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
  }
  const targetCard = stagesList.querySelector(`[data-tab-id="${tabId}"]`);
  if (targetCard) {
    targetCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

/**
 * Show rich hover popover preview to the left of the minimap rail
 * @param {object} tab
 * @param {HTMLElement} cardEl
 */
function showMinimapPopover(tab, cardEl) {
  if (!minimapPopover) return;
  activePopoverTabId = tab.id;

  popoverTitle.textContent = tab.title || '新标签页';
  popoverFavicon.src = tab.favIconUrl || getFallbackFavicon(tab.url);
  popoverFavicon.onerror = () => { popoverFavicon.src = getFallbackFavicon(tab.url); };

  const normUrl = normalizeUrl(tab.url);
  const cached = thumbnailCache.get(tab.id);

  popoverPreview.innerHTML = '';
  if (cached && cached.url === normUrl && cached.dataUrl) {
    const img = document.createElement('img');
    img.className = 'sm-popover-img';
    img.src = cached.dataUrl;
    img.alt = tab.title || '';
    popoverPreview.appendChild(img);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'sm-popover-placeholder';
    const fav = document.createElement('img');
    fav.className = 'sm-mini-favicon';
    fav.style.width = '24px';
    fav.style.height = '24px';
    fav.src = tab.favIconUrl || getFallbackFavicon(tab.url);
    fav.onerror = () => { fav.style.display = 'none'; };
    const domain = document.createElement('span');
    domain.className = 'sm-popover-domain';
    domain.textContent = extractDomain(tab.url) || tab.title || '新标签页';
    placeholder.appendChild(fav);
    placeholder.appendChild(domain);
    popoverPreview.appendChild(placeholder);
  }

  // Position popover vertically aligned with mini card
  const cardRect = cardEl.getBoundingClientRect();
  const popoverHeight = 160;
  const topPos = Math.max(10, Math.min(window.innerHeight - popoverHeight - 12, cardRect.top - 20));

  minimapPopover.style.top = `${topPos}px`;
  if (minimapPosition === 'left') {
    minimapPopover.style.left = '66px';
    minimapPopover.style.right = 'auto';
  } else {
    minimapPopover.style.right = '66px';
    minimapPopover.style.left = 'auto';
  }
  minimapPopover.style.display = 'block';
}

/**
 * Hide Minimap Popover
 */
function hideMinimapPopover() {
  activePopoverTabId = null;
  if (minimapPopover) {
    minimapPopover.style.display = 'none';
  }
}

/**
 * Schedule rAF throttle for slider updates
 */
function scheduleMinimapSliderUpdate() {
  if (sliderUpdateScheduled) return;
  sliderUpdateScheduled = true;
  requestAnimationFrame(() => {
    sliderUpdateScheduled = false;
    updateMinimapSlider();
  });
}

/**
 * Synchronize Minimap Viewport Slider position and height with corridor scroll
 */
function updateMinimapSlider() {
  if (!minimapEnabled || smMinimap.classList.contains('is-hidden') || !minimapScrollContainer || !minimapSlider) return;

  const corridorScrollTop = stageCorridor.scrollTop;
  const corridorScrollHeight = stageCorridor.scrollHeight;
  const corridorClientHeight = stageCorridor.clientHeight;
  const containerHeight = minimapScrollContainer.clientHeight;
  const trackHeight = minimapTrack.scrollHeight;

  if (corridorScrollHeight <= corridorClientHeight || containerHeight <= 0) {
    minimapSlider.style.display = 'none';
    minimapTrack.style.transform = 'translateY(0px)';
    return;
  }

  minimapSlider.style.display = 'block';

  const maxCorridorScroll = corridorScrollHeight - corridorClientHeight;
  const scrollProgress = Math.min(1, Math.max(0, corridorScrollTop / maxCorridorScroll));

  // Slider height reflects visible portion of the corridor
  const visibleRatio = corridorClientHeight / corridorScrollHeight;
  const sliderHeight = Math.max(26, Math.min(containerHeight, Math.round(containerHeight * visibleRatio)));
  const maxSliderTravel = containerHeight - sliderHeight;
  const sliderTop = Math.round(scrollProgress * maxSliderTravel);

  minimapSlider.style.height = `${sliderHeight}px`;
  minimapSlider.style.transform = `translateY(${sliderTop}px)`;

  // If mini cards track is taller than container, scroll track in sync
  if (trackHeight > containerHeight) {
    const maxTrackScroll = trackHeight - containerHeight;
    const trackOffset = Math.round(scrollProgress * maxTrackScroll);
    minimapTrack.style.transform = `translateY(-${trackOffset}px)`;
  } else {
    minimapTrack.style.transform = 'translateY(0px)';
  }
}

/**
 * Apply Minimap Position (Left or Right)
 * @param {'left'|'right'} pos
 */
function applyMinimapPosition(pos) {
  minimapPosition = pos;
  localStorage.setItem('sm_minimap_position', pos);
  if (bodyWrapper) {
    bodyWrapper.classList.toggle('minimap-left', pos === 'left');
  }
  const bottomBar = document.getElementById('bottom-bar');
  if (bottomBar) {
    bottomBar.classList.toggle('minimap-left', pos === 'left');
  }
  if (btnMinimapPos) {
    btnMinimapPos.title = pos === 'left'
      ? '当前在左侧，点击切换到右侧 (右键亦可切换)'
      : '当前在右侧，点击切换到左侧 (右键亦可切换)';
  }
  scheduleMinimapSliderUpdate();
}

/**
 * Toggle Minimap Position between Left and Right
 */
function toggleMinimapPosition() {
  const nextPos = minimapPosition === 'left' ? 'right' : 'left';
  applyMinimapPosition(nextPos);
  Logger.info('Minimap', `已切换缩略图目录至${nextPos === 'left' ? '左侧' : '右侧'}`);
}

/**
 * Setup Minimap UI Interactions (Drag, Click, Wheel, Toggle, Position)
 */
function setupMinimapInteractions() {
  if (!btnMinimapToggle || !smMinimap) return;

  // Apply stored position (Left or Right)
  applyMinimapPosition(minimapPosition);

  // Initial state
  btnMinimapToggle.classList.toggle('is-active', minimapEnabled);
  if (!minimapEnabled) {
    smMinimap.classList.add('is-hidden');
  }

  // Toggle button in header
  btnMinimapToggle.addEventListener('click', () => {
    minimapEnabled = !minimapEnabled;
    localStorage.setItem('sm_minimap_enabled', String(minimapEnabled));
    btnMinimapToggle.classList.toggle('is-active', minimapEnabled);
    smMinimap.classList.toggle('is-hidden', !minimapEnabled);
    if (minimapEnabled) {
      render();
    } else {
      hideMinimapPopover();
    }
  });

  // Position Toggle Button in Minimap Header
  if (btnMinimapPos) {
    btnMinimapPos.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMinimapPosition();
    });
  }

  // Right-click on minimap rail quickly toggles left/right position
  smMinimap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    toggleMinimapPosition();
  });

  // Sync Slider when Corridor Scrolls
  stageCorridor.addEventListener('scroll', () => {
    scheduleMinimapSliderUpdate();
  }, { passive: true });

  // Sync on window resize
  window.addEventListener('resize', () => {
    scheduleMinimapSliderUpdate();
  });

  // Slider Dragging: Pre-calculate boundaries ONCE on pointerdown for buttery smooth 120 FPS dragging
  minimapSlider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideMinimapPopover();
    isDraggingSlider = true;
    dragStartY = e.clientY;
    dragStartScrollTop = stageCorridor.scrollTop;

    // Cache metrics once at drag start (eliminating synchronous reflows in pointermove!)
    dragContainerHeight = minimapScrollContainer.clientHeight;
    dragSliderHeight = minimapSlider.offsetHeight;
    dragMaxSliderTravel = dragContainerHeight - dragSliderHeight;
    dragMaxCorridorScroll = stageCorridor.scrollHeight - stageCorridor.clientHeight;

    document.body.classList.add('is-minimap-dragging');
    minimapSlider.classList.add('is-dragging');
    minimapSlider.setPointerCapture(e.pointerId);
  });

  minimapSlider.addEventListener('pointermove', (e) => {
    if (!isDraggingSlider) return;
    if (dragMaxSliderTravel <= 0 || dragMaxCorridorScroll <= 0) return;

    const deltaY = e.clientY - dragStartY;
    const targetScroll = Math.max(0, Math.min(dragMaxCorridorScroll, dragStartScrollTop + deltaY * (dragMaxCorridorScroll / dragMaxSliderTravel)));

    // Instant direct assignment ensures 100% zero-latency tracking
    stageCorridor.scrollTop = targetScroll;
  });

  const stopDragging = (e) => {
    if (isDraggingSlider) {
      isDraggingSlider = false;
      document.body.classList.remove('is-minimap-dragging');
      minimapSlider.classList.remove('is-dragging');
      try {
        minimapSlider.releasePointerCapture(e.pointerId);
      } catch (err) {}
    }
  };
  minimapSlider.addEventListener('pointerup', stopDragging);
  minimapSlider.addEventListener('pointercancel', stopDragging);

  // Click on Track Area to Jump/Scroll directly
  minimapScrollContainer.addEventListener('click', (e) => {
    if (e.target.closest('.sm-mini-card') || e.target === minimapSlider) return;
    const rect = minimapScrollContainer.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    const containerHeight = minimapScrollContainer.clientHeight;
    const sliderHeight = minimapSlider.offsetHeight || 30;
    const maxSliderTravel = containerHeight - sliderHeight;
    const maxCorridorScroll = stageCorridor.scrollHeight - stageCorridor.clientHeight;

    if (maxSliderTravel > 0 && maxCorridorScroll > 0) {
      const targetSliderTop = Math.max(0, Math.min(maxSliderTravel, clickY - sliderHeight / 2));
      const progress = targetSliderTop / maxSliderTravel;
      stageCorridor.scrollTo({
        top: progress * maxCorridorScroll,
        behavior: 'smooth'
      });
    }
  });

  // Wheel over Minimap forwards directly to Stage Corridor
  minimapScrollContainer.addEventListener('wheel', (e) => {
    stageCorridor.scrollTop += e.deltaY;
  }, { passive: true });

  // Hide popover when mouse leaves rail
  smMinimap.addEventListener('mouseleave', () => {
    hideMinimapPopover();
  });
}

/**
 * Utility Helpers
 */
function extractDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

function getFallbackFavicon(url) {
  const domain = extractDomain(url);
  if (!domain) {
    return 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="%239aa0a6"><circle cx="12" cy="12" r="10"/></svg>';
  }
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
}

// Start
document.addEventListener('DOMContentLoaded', init);
