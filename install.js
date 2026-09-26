const installButton = document.querySelector("#install-app");
const installStatus = document.querySelector("#install-status");
let installPrompt;

if (globalThis.matchMedia("(display-mode: standalone)").matches || globalThis.navigator.standalone === true) {
  installButton.hidden = true;
}

globalThis.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
});

installButton.addEventListener("click", async () => {
  if (!installPrompt) {
    installStatus.textContent = "Use your browser menu and choose Install app or Add to Home Screen to save this shop.";
    installStatus.hidden = false;
    return;
  }

  await installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = undefined;
});

globalThis.addEventListener("appinstalled", () => {
  installPrompt = undefined;
  installButton.hidden = true;
  installStatus.textContent = "Timber & Tackle is installed and ready to launch.";
  installStatus.hidden = false;
});
