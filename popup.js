document.addEventListener("DOMContentLoaded", async () => {
  const listContainer = document.getElementById("episode-list");
  const statusText = document.getElementById("status");
  const selectAllBox = document.getElementById("select-all");
  const downloadBtn = document.getElementById("download-btn");
  const selectAllButton = document.getElementById("select-all-btn");
  const seasonOneButton = document.getElementById("season-one-btn");
  const deselectAllButton = document.getElementById("deselect-all-btn");
  const optionsLink = document.getElementById("options-link");

  let discoveredEpisodes = [];

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    statusText.innerText = "No active tab found.";
    return;
  }

  // Scrape in the active page so the popup remains a thin queue-selection UI.
  chrome.scripting.executeScript(
    {
      target: { tabId: tab.id },
      func: scrapePageLinks,
    },
    (results) => {
      if (!results || !results[0] || !results[0].result) {
        statusText.innerText = "Failed to inspect page.";
        return;
      }

      discoveredEpisodes = results[0].result;

      if (discoveredEpisodes.length === 0) {
        statusText.innerText = "No downloadable episode links found.";
        return;
      }

      renderEpisodeList(discoveredEpisodes);
    }
  );

  function renderEpisodeList(episodes) {
    listContainer.innerHTML = "";
    episodes.forEach((ep, idx) => {
      const itemDiv = document.createElement("div");
      itemDiv.className = "item";

      itemDiv.innerHTML = `
        <input type="checkbox" class="ep-checkbox" data-index="${idx}">
        <label>${ep.fileTitle || ep.title}</label>
      `;

      listContainer.appendChild(itemDiv);
    });

    listContainer.addEventListener("change", updateButtonCount);
  }

  function updateButtonCount() {
    const checked = document.querySelectorAll(".ep-checkbox:checked");
    downloadBtn.innerText = `Download (${checked.length})`;
    downloadBtn.disabled = checked.length === 0;
  }

  selectAllBox.addEventListener("change", (e) => {
    setCheckboxes(() => e.target.checked);
  });

  selectAllButton.addEventListener("click", () => setCheckboxes(() => true));
  seasonOneButton.addEventListener("click", () => setCheckboxes((episode) => /^S01E/i.test(episode.title)));
  deselectAllButton.addEventListener("click", () => setCheckboxes(() => false));
  optionsLink.addEventListener("click", () => chrome.runtime.openOptionsPage());

  function setCheckboxes(predicate) {
    document.querySelectorAll(".ep-checkbox").forEach((checkbox) => {
      const episode = discoveredEpisodes[Number(checkbox.dataset.index)];
      checkbox.checked = predicate(episode);
    });
    selectAllBox.checked = Array.from(document.querySelectorAll(".ep-checkbox")).every((checkbox) => checkbox.checked);
    updateButtonCount();
  }

  downloadBtn.addEventListener("click", () => {
    const selectedCheckboxes = document.querySelectorAll(".ep-checkbox:checked");
    
    const selectedQueue = Array.from(selectedCheckboxes).map((cb) => {
      const index = cb.getAttribute("data-index");
      return discoveredEpisodes[index];
    });

    if (selectedQueue.length === 0) return;

    // Send only the checked metadata; the service worker owns automation and
    // keeps processing after this popup closes.
    chrome.runtime.sendMessage(
      {
        action: "START_BATCH_DOWNLOAD",
        payload: selectedQueue,
      },
      (response) => {
        window.close();
      }
    );
  });
});

function scrapePageLinks() {
  const links = Array.from(document.querySelectorAll("a[href]"));
  const episodes = [];
  const seriesName = getSeriesName();

  // Preserve the series/season metadata needed for organized filenames.
  links.forEach((a) => {
    const href = a.href.trim();
    const text = a.innerText.trim();

    if (/bollywood|korean|philippine|how to download|can't download/i.test(text)) {
      return;
    }

    if (/downloadwella|pixeldrain|mega\.nz|\.mkv|\.mp4/i.test(href)) {
      const match = href.match(/S\d+E\d+/i) || text.match(/S\d+E\d+/i);
      const episodeCode = match ? match[0].toUpperCase() : "";
      const seasonCode = episodeCode.match(/^S\d+/i)?.[0].toUpperCase() || "";
      const surroundingText = a.closest("li, article, tr, .item, .episode, [class*='episode']")?.innerText || "";
      const movieName = getMovieName(href, text, surroundingText, seriesName);
      const fileTitle = episodeCode
        ? getFullFileTitle(href, text, surroundingText, episodeCode, seriesName)
        : movieName;

      episodes.push({
        title: episodeCode || movieName,
        fileTitle: fileTitle || `${seriesName}${episodeCode ? ` ${episodeCode}` : ""}`,
        seriesName,
        seriesFolder: seasonCode ? `${seriesName} ${seasonCode}` : seriesName,
        url: href,
      });
    }
  });

  return episodes;

  function getFullFileTitle(href, linkText, rowText, episodeCode, series) {
    return `${series} ${episodeCode}`;
  }

  function getMovieName(href, linkText, rowText, series) {
    const pathName = decodeURIComponent(href.split("?")[0].split("#")[0].split("/").pop() || "")
      .replace(/\.(mkv|mp4|avi|mov)$/i, "")
      .replace(/[._]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const source = (linkText.length > 4 ? linkText : rowText)
      .replace(/\b(download|watch|click here|create download link)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    return (source.length > 4 ? source : pathName || series)
      .replace(/\s+/g, " ")
      .trim();
  }

  function getSeriesName() {
    const heading = document.querySelector("h1");
    const rawName = heading?.innerText || document.title || "Series";
    return rawName
      .replace(/^\s*download\s+/i, "")
      .replace(/\s*[|:-]\s*(Nkiri|download|episodes?).*$/i, "")
      .replace(/\s+S\d+\b.*$/i, "")
      .replace(/\s*season\s*\d+.*$/i, "")
      .replace(/\s*\(.*$/, "")
      .replace(/\s+/g, " ")
      .trim() || "Series";
  }
}