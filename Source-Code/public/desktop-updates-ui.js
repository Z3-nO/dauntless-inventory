"use strict";
let desktopUpdateLoaded = false;
let desktopUpdateAction = false;
let desktopUpdateState = null;
function showDesktopUpdate(state) {
  desktopUpdateState = state;
  if (!desktopUpdateLoaded) {
    $("app-update-auto").checked = state.automaticDownload;
    $("app-update-next-start").checked = state.applyOnNextStart;
    $("app-update-live-restart").checked = state.restartForLiveUpdates;
    desktopUpdateLoaded = true;
  }
  $("app-update-version").textContent =
    "Application " +
    state.currentVersion +
    (state.availableVersion ? " · Downloaded " + state.availableVersion : "");
  $("app-update-status").textContent =
    state.message + (state.progress !== null ? " " + state.progress + "%" : "");
  $("app-update-check").disabled = state.busy || desktopUpdateAction;
  $("app-update-restart").hidden = !state.ready;
  $("app-update-banner").hidden = !state.ready;
  $("app-update-banner-text").textContent = state.ready
    ? state.requiredLiveVersion && state.restartForLiveUpdates
      ? "A required Live compatibility update is ready. Inventory will restart automatically after current saves finish."
      : "Inventory " + state.availableVersion + " is ready."
    : "";
  for (const id of ["app-update-restart", "app-update-banner-restart"])
    $(id).disabled =
      state.busy || desktopUpdateAction || pending || buildBusy || addingSlots;
}
async function refreshDesktopUpdates() {
  if (!window.desktop?.applicationUpdateStatus || desktopUpdateAction) return;
  try {
    showDesktopUpdate(await window.desktop.applicationUpdateStatus());
  } catch (error) {
    $("app-update-status").textContent = error.message;
  }
}
async function desktopAction(action) {
  if (desktopUpdateAction || !window.desktop) return;
  if (action === "restart" && (pending || buildBusy || addingSlots)) {
    $("app-update-status").textContent =
      "Finish the current save or review before restarting.";
    return;
  }
  desktopUpdateAction = true;
  $("app-update-check").disabled = true;
  $("app-update-status").textContent =
    action === "restart"
      ? "Finishing current operations and restarting…"
      : "Working…";
  try {
    if (action === "restart") await window.desktop.restartApplicationUpdate();
    else if (action === "check")
      showDesktopUpdate(await window.desktop.checkApplicationUpdate());
    else
      showDesktopUpdate(
        await window.desktop.saveApplicationUpdateSettings({
          automaticDownload: $("app-update-auto").checked,
          applyOnNextStart: $("app-update-next-start").checked,
          restartForLiveUpdates: $("app-update-live-restart").checked,
        }),
      );
  } catch (error) {
    $("app-update-status").textContent = error.message;
  } finally {
    desktopUpdateAction = false;
    $("app-update-check").disabled = false;
    for (const id of ["app-update-restart", "app-update-banner-restart"])
      $(id).disabled =
        !!desktopUpdateState?.busy || pending || buildBusy || addingSlots;
  }
}
$("app-update-check").onclick = () => desktopAction("check");
$("app-update-save").onclick = () => desktopAction("settings");
for (const id of ["app-update-restart", "app-update-banner-restart"])
  $(id).onclick = () => desktopAction("restart");
if (window.desktop?.onApplicationUpdate) {
  window.desktop.onApplicationUpdate(showDesktopUpdate);
  refreshDesktopUpdates();
} else {
  $("app-update-status").textContent =
    "Open the portable EXE to manage application updates.";
  for (const id of ["app-update-check", "app-update-save"])
    $(id).disabled = true;
}
$("open-settings").addEventListener("click", refreshDesktopUpdates);
setInterval(() => {
  if ($("settings-dialog").open && !document.hidden) refreshDesktopUpdates();
}, 10000);

if (window.desktop?.onApplicationRestart) {
  window.desktop.onApplicationRestart(async ({ id }) => {
    try {
      await window.desktop.saveApplicationDraft({
        id,
        draft: {
          version: version(),
          selection: structuredClone(selection),
          mode: $("mode").value,
          maximize: $("maximize").checked,
          buildCode: $("build-code").value,
          character: $("character").value,
        },
      });
    } catch (error) {
      notice(error.message, true);
    }
  });
  document.addEventListener("settings-loaded", async () => {
    try {
      const draft = await window.desktop.loadApplicationDraft();
      if (!draft || !catalogs[draft.version]) return;
      $("version").value = draft.version;
      $("version").onchange();
      const supported = new Set(
        catalogs[draft.version]
          .filter((item) => item.editable)
          .map((item) => item.id),
      );
      selection = Object.fromEntries(
        Object.entries(draft.selection).filter(([id]) => supported.has(id)),
      );
      if (draft.character)
        liveDrafts.set(draft.character, structuredClone(selection));
      $("mode").value = draft.mode;
      $("maximize").checked = draft.maximize;
      $("build-code").value = draft.buildCode;
      basket();
      render();
      notice(
        "Inventory updated. Your pending selection and build code were restored; connect the character and review before applying.",
      );
    } catch (error) {
      notice(error.message, true);
    }
  });
}
