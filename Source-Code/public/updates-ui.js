"use strict";
let updatePanelBusy = false;
let updatePanelLoaded = false;

function showUpdateStatus(result) {
  if (!updatePanelLoaded) {
    $("update-feed").value = result.feedUrl;
    $("updates-check-auto").checked = result.automaticCheck;
    $("updates-install-auto").checked = result.automaticInstall;
    updatePanelLoaded = true;
  }
  $("updates-version").textContent =
    "Included module: " +
    result.bundledVersion +
    (result.downloadedVersion
      ? " · Verified download: " + result.downloadedVersion
      : "");
  const messages = [
    result.message,
    result.versions[settingsVersion()]?.message,
  ].filter(Boolean);
  $("updates-status").textContent = messages.join(" ");
  $("updates-apply").disabled = result.busy || updatePanelBusy;
}

async function loadUpdateStatus() {
  if (updatePanelBusy) return;
  try {
    showUpdateStatus(
      await api("live-update-status", { version: settingsVersion() }),
    );
  } catch (error) {
    $("updates-status").textContent = error.message;
  }
}

async function updateAction(action, extra = {}) {
  if (updatePanelBusy) return;
  updatePanelBusy = true;
  for (const id of [
    "updates-check",
    "updates-apply",
    "updates-import",
    "updates-save",
  ])
    $(id).disabled = true;
  $("updates-status").textContent = "Working…";
  try {
    const result = await api("live-update-" + action, {
      version: settingsVersion(),
      root: $("root").value.trim(),
      ...extra,
    });
    if (result.message) $("updates-status").textContent = result.message;
  } catch (error) {
    $("updates-status").textContent = error.message;
  } finally {
    updatePanelBusy = false;
    for (const id of [
      "updates-check",
      "updates-apply",
      "updates-import",
      "updates-save",
    ])
      $(id).disabled = false;
  }
}

$("updates-check").onclick = () => updateAction("check");
$("updates-apply").onclick = () => updateAction("apply");
$("updates-save").onclick = () =>
  updateAction("settings", {
    feedUrl: $("update-feed").value.trim(),
    automaticCheck: $("updates-check-auto").checked,
    automaticInstall: $("updates-install-auto").checked,
  });
$("updates-import").onclick = async () => {
  if (!window.desktop) {
    $("updates-status").textContent =
      "Open the desktop app to choose an update folder.";
    return;
  }
  const folder = await window.desktop.chooseFolder();
  if (folder) await updateAction("import", { folder });
};
document.addEventListener("settings-loaded", loadUpdateStatus);
$("open-settings").addEventListener("click", loadUpdateStatus);
$("settings-version").addEventListener("change", loadUpdateStatus);
setInterval(() => {
  if ($("settings-dialog").open && !document.hidden) loadUpdateStatus();
}, 10000);
