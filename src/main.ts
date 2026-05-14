declare const APP_VERSION: string;

document.addEventListener("DOMContentLoaded", () => {
  const versionElement = document.getElementById("title-version");
  if (versionElement) {
    versionElement.textContent = `v${APP_VERSION}`;
  }
});
