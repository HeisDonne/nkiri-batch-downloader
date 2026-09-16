const directoryInput = document.getElementById("master-directory");
const saveButton = document.getElementById("save");
const downloadsButton = document.getElementById("use-downloads");
const statusText = document.getElementById("status");

chrome.storage.sync.get({ masterDirectory: "" }, (settings) => {
  directoryInput.value = settings.masterDirectory;
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

  chrome.storage.sync.set({ masterDirectory }, () => {
    statusText.textContent = masterDirectory ? "Settings saved." : "Using Downloads folder.";
    setTimeout(() => {
      statusText.textContent = "";
    }, 2000);
  });
}
