let totalQueueCount = 0;
let completedCount = 0;
const activeDownloads = new Map();
const pendingTabs = new Map();
const terminalDownloadStates = new Map();
let masterDirectory = "";
const MAX_EPISODE_RETRIES = 3;

// Load the optional folder setting before the queue starts so every item in a
// batch uses the same relative download root.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "START_BATCH_DOWNLOAD") return true;

  totalQueueCount = message.payload.length;
  completedCount = 0;
  chrome.storage.sync.get({ masterDirectory: "" }, (settings) => {
    masterDirectory = normalizeDirectory(settings.masterDirectory);
    updateBadgeText(`0/${totalQueueCount}`, "#313244", "#89b4fa");
    processDownloadQueue(message.payload);
    sendResponse({ status: "QUEUE_RECEIVED", count: totalQueueCount });
  });
  return true;
});

async function processDownloadQueue(items) {
  // Keep the queue sequential: each hoster tab must resolve before the next
  // item starts, while Chrome's download manager handles the actual transfer.
  for (const item of items) {
    try {
      const filename = getFilename(item);
      if (await checkIfFileExists(filename)) {
        console.log(`[Skipped] Already downloaded: ${filename}`);
        handleDownloadFinished();
        continue;
      }
      await retryEpisode(item);
    } catch (error) {
      console.error(`[Automation Failed] ${item.title}:`, error);
      notifyError(item, error.message);
      handleDownloadFinished();
    }
  }

  notifyBatchFinished(items.length);
}

async function retryEpisode(item) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_EPISODE_RETRIES; attempt++) {
    try {
      await automateEpisode(item);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_EPISODE_RETRIES) {
        console.warn(`[Retry ${attempt}/${MAX_EPISODE_RETRIES - 1}] ${item.title}: ${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }
  throw lastError;
}

function getFilename(item) {
  const series = sanitizePart(item.seriesFolder || item.seriesName || "Series_Downloads");
  const episode = sanitizePart(item.fileTitle || item.title);
  return `${masterDirectory ? `${masterDirectory}/` : ""}${series}/${episode}.mkv`;
}

function normalizeDirectory(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .map(sanitizePart)
    .filter(Boolean)
    .join("/");
}

function notifyBatchFinished(count) {
  chrome.notifications.create(`batch-finished-${Date.now()}`, {
    type: "basic",
    title: "Series downloads finished",
    message: `Processed ${count} episode${count === 1 ? "" : "s"}.`,
    priority: 1,
  });
}

function notifyError(item, message) {
  chrome.notifications.create(`download-error-${Date.now()}`, {
    type: "basic",
    title: `Download failed: ${item.title}`,
    message: message || "The episode could not be downloaded after three attempts.",
    priority: 2,
  });
}

function sanitizePart(value) {
  return String(value || "Untitled")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "") || "Untitled";
}

function checkIfFileExists(filename) {
  return new Promise((resolve) => {
    chrome.downloads.search({}, (results) => {
      if (chrome.runtime.lastError || !results) {
        resolve(false);
        return;
      }

      const expectedPaths = [filename, getLegacyFilename(filename)]
        .map((path) => normalizeDownloadPath(path));
      resolve(results.some((download) => {
        const actualPath = String(download.filename || "").replace(/\\/g, "/").toLowerCase();
        return download.exists && download.state === "complete" &&
          expectedPaths.some((expectedPath) =>
            actualPath.endsWith(`/${expectedPath}`) || actualPath === expectedPath
          );
      }));
    });
  });
}

// Match both the configured path and files created before a master directory
// was configured, so changing the option does not create duplicate downloads.
function normalizeDownloadPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}

function getLegacyFilename(filename) {
  const normalized = normalizeDownloadPath(filename);
  const master = normalizeDownloadPath(masterDirectory);
  if (!master || !normalized.startsWith(`${master}/`)) return normalized;
  return normalized.slice(master.length + 1);
}

function askToRedownload(item) {
  return new Promise((resolve) => {
    const id = `redownload-${Date.now()}`;
    const onButton = (notificationId, buttonIndex) => {
      if (notificationId !== id) return;
      cleanup();
      resolve(buttonIndex === 0);
    };
    const onClosed = (notificationId) => {
      if (notificationId !== id) return;
      cleanup();
      resolve(false);
    };
    const cleanup = () => {
      chrome.notifications.onButtonClicked.removeListener(onButton);
      chrome.notifications.onClosed.removeListener(onClosed);
      chrome.notifications.clear(id);
    };

    chrome.notifications.create(id, {
      type: "basic",
      title: "Episode already downloaded",
      message: `${item.title} was already downloaded. Redownload it?`,
      buttons: [{ title: "Redownload" }, { title: "Skip" }],
      priority: 2,
    });
    chrome.notifications.onButtonClicked.addListener(onButton);
    chrome.notifications.onClosed.addListener(onClosed);
  });
}

function automateEpisode(item) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url: item.url, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab || tab.id === undefined) {
        reject(new Error(chrome.runtime.lastError?.message || "Could not create episode tab"));
        return;
      }

      const pending = {
        item,
        rootTabId: tab.id,
        tabIds: new Set([tab.id]),
        running: new Set(),
        resolve,
        reject,
        finished: false,
      };
      pendingTabs.set(tab.id, pending);
      pending.timeout = setTimeout(() => failAutomation(pending, "Timed out waiting for download controls"), 120000);
      processTabWhenComplete(pending, tab.id);
    });
  });
}

// Re-run page inspection after each navigation because hosters commonly move
// from the source page to a link-generator page and then to the media page.
function processTabWhenComplete(pending, tabId) {
  const listener = (updatedTabId, changeInfo) => {
    if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
    chrome.tabs.onUpdated.removeListener(listener);
    injectPageAutomation(pending, tabId);
  };
  chrome.tabs.onUpdated.addListener(listener);
  pending.listeners = pending.listeners || new Map();
  pending.listeners.set(tabId, listener);

  chrome.tabs.get(tabId, (tab) => {
    if (!chrome.runtime.lastError && tab && tab.status === "complete") {
      chrome.tabs.onUpdated.removeListener(listener);
      injectPageAutomation(pending, tabId);
    }
  });
}

function injectPageAutomation(pending, tabId) {
  if (pending.finished || pending.running.has(tabId)) return;
  pending.running.add(tabId);
  chrome.scripting.executeScript({ target: { tabId }, func: automateDownloadPage }, (results) => {
    pending.running.delete(tabId);
    if (pending.finished) return;

    if (chrome.runtime.lastError || !results || !results[0]) {
      processTabWhenComplete(pending, tabId);
      return;
    }

    const result = results[0].result || {};
    if (result.kind === "media") {
      startNativeDownload(result.url, pending);
    } else if (result.kind === "clicked" || result.kind === "waiting") {
      setTimeout(() => {
        if (!pending.finished) processTabWhenComplete(pending, tabId);
      }, result.kind === "waiting" ? 1000 : 1500);
    } else {
      failAutomation(pending, result.message || "No download control found");
    }
  });
}

function isMediaUrl(url) {
  return /^https?:/i.test(url) &&
    !/\.html?(?:$|[?#])/i.test(url) &&
    (/\.(mkv|mp4|avi|mov)(?:$|[?#])/i.test(url) || /(?:download|stream|media|videofile)/i.test(url));
}

async function startNativeDownload(url, pending) {
  if (pending.finished || !isMediaUrl(url)) return;
  pending.finished = true;
  clearTimeout(pending.timeout);
  pendingTabs.delete(pending.rootTabId);

  chrome.downloads.download({
    url,
    filename: getFilename(pending.item),
    saveAs: false,
    conflictAction: "uniquify",
  }, (downloadId) => {
    if (chrome.runtime.lastError || downloadId === undefined) {
      failDownload(pending, chrome.runtime.lastError?.message || "Could not start native download");
      return;
    }

    let resolveDownload;
    let rejectDownload;
    const completion = new Promise((resolve, reject) => {
      resolveDownload = resolve;
      rejectDownload = reject;
    });
    activeDownloads.set(downloadId, {
      pending,
      resolveDownload,
      rejectDownload,
    });
    const terminalState = terminalDownloadStates.get(downloadId);
    if (terminalState) {
      terminalDownloadStates.delete(downloadId);
      settleDownload(downloadId, terminalState, activeDownloads.get(downloadId));
    }
    checkDownloadState(downloadId);
    closePendingTabs(pending);
    pending.resolve(downloadId);
  });
}

// A terminal download event can race the callback that registers the ID;
// checking history immediately closes that small timing gap.
function checkDownloadState(downloadId) {
  const download = activeDownloads.get(downloadId);
  if (!download) return;

  chrome.downloads.search({ id: downloadId }, (results) => {
    if (chrome.runtime.lastError || !results || !results[0]) return;
    const state = results[0].state;
    if (state === "complete" || state === "interrupted") {
      settleDownload(downloadId, state, download);
    }
  });
}

function closePendingTabs(pending) {
  for (const tabId of pending.tabIds) chrome.tabs.remove(tabId).catch(() => {});
}

function failDownload(pending, message) {
  closePendingTabs(pending);
  pending.reject(new Error(message));
}

function failAutomation(pending, message) {
  if (pending.finished) return;
  pending.finished = true;
  clearTimeout(pending.timeout);
  pendingTabs.delete(pending.rootTabId);
  closePendingTabs(pending);
  pending.reject(new Error(message));
}

// Runs in the current page and advances one visible stage at a time.
async function automateDownloadPage() {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const visible = (element) => element && element.offsetWidth > 0 && element.offsetHeight > 0;
  const label = (element) => `${element.value || ""} ${element.textContent || ""}`.replace(/\s+/g, " ").trim();
  const controls = Array.from(document.querySelectorAll("a, button, input[type='button'], input[type='submit'], input[type='image']"));

  const mediaControl = controls.find((element) => {
    const url = element.href || element.dataset?.url || element.getAttribute("data-download-url") || "";
    return visible(element) && /\.(mkv|mp4|avi|mov)(?:$|[?#])/i.test(url);
  });
  if (mediaControl) return { kind: "media", url: mediaControl.href || mediaControl.dataset?.url };

  const createLink = controls.find((element) => visible(element) &&
    /create\s+(download\s+)?link|generate\s+(download\s+)?link|get\s+download\s+link/i.test(label(element)));
  if (createLink) {
    createLink.click();
    return { kind: "clicked" };
  }

  const freeDownload = controls.find((element) => visible(element) &&
    (element.name === "method_free" || /free\s+download/i.test(label(element))));
  if (freeDownload) {
    freeDownload.click();
    await sleep(1500);
    return { kind: "clicked" };
  }

  const finalButton = document.querySelector("#btn_download, input[value*='Direct Download'], input[value*='Download File']");
  if (visible(finalButton) && !finalButton.disabled && !finalButton.hasAttribute("disabled")) {
    finalButton.click();
    return { kind: "clicked" };
  }

  return { kind: "waiting" };
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId === undefined) return;
  const pending = Array.from(pendingTabs.values()).find((entry) => entry.tabIds.has(tab.openerTabId));
  if (!pending || tab.id === undefined) return;
  pending.tabIds.add(tab.id);
  processTabWhenComplete(pending, tab.id);
});

// Some final buttons start the media request directly instead of opening a tab.
chrome.downloads.onCreated.addListener((downloadItem) => {
  const pending = Array.from(pendingTabs.values()).find((entry) =>
    !entry.finished && isMediaUrl(downloadItem.url || "")
  );
  if (!pending) return;

  chrome.downloads.cancel(downloadItem.id, () => {
    if (chrome.runtime.lastError) return;
    startNativeDownload(downloadItem.url, pending);
  });
});

chrome.downloads.onChanged.addListener((delta) => {
  const download = activeDownloads.get(delta.id);
  if (!delta.state || !["complete", "interrupted"].includes(delta.state.current)) return;
  if (!download) {
    terminalDownloadStates.set(delta.id, delta.state.current);
    return;
  }
  settleDownload(delta.id, delta.state.current, download);
});

function settleDownload(downloadId, state, download) {
  if (!activeDownloads.has(downloadId)) return;
  activeDownloads.delete(downloadId);
  if (state === "complete") download.resolveDownload();
  else download.rejectDownload(new Error("Download interrupted"));
  handleDownloadFinished();
}


function handleDownloadFinished() {
  completedCount++;
  if (completedCount >= totalQueueCount) {
    updateBadgeText("DONE", "#1e1e2e", "#a6e3a1");
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 5000);
  } else {
    updateBadgeText(`${completedCount}/${totalQueueCount}`, "#313244", "#89b4fa");
  }
}

function updateBadgeText(text, textColorHex, bgColorHex) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: bgColorHex });
  if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: textColorHex });
}
