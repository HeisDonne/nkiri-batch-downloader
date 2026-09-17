const directoryInput = document.getElementById("master-directory");
const saveButton = document.getElementById("save");
const downloadsButton = document.getElementById("use-downloads");
const statusText = document.getElementById("status");

chrome.storage.sync.get({ masterDirectory: "" }, (settings) => {
  directoryInput.value = /^untitled$/i.test(settings.masterDirectory.trim())
    ? ""
    : settings.masterDirectory;
});

saveButton.addEventListener("click", () => {
  saveDirectory(directoryInput.value);
});

downloadsButton.addEventListener("click", () => {
  directoryInput.value = "";
  saveDirectory("");
});

function saveDirectory(value) {
  const masterDirectory = value
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");

  const normalizedDirectory = /^untitled$/i.test(masterDirectory) ? "" : masterDirectory;
  chrome.storage.sync.set({ masterDirectory: normalizedDirectory }, () => {
    statusText.textContent = normalizedDirectory ? "Settings saved." : "Using Downloads folder.";
    setTimeout(() => {
      statusText.textContent = "";
    }, 2000);
  });
}
