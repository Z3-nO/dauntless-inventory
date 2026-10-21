"use strict";
let livePollBusy = false;
let livePollPromise = null;
let discoveryBusy = false;
let previousLiveCapability = "";
function showLive(result) {
  liveConnected = result.live === true;
  liveSessionRequested = liveConnected;
  liveWritesReady =
    liveConnected && LiveSession.ready(result, $("character").value);
  const capability = JSON.stringify([
    liveConnected,
    liveWritesReady,
    result.nativeRefresh?.builds,
  ]);
  if (capability !== previousLiveCapability) {
    previousLiveCapability = capability;
    document.dispatchEvent(new Event("live-state-changed"));
  }
  const panel = $("live-status");
  panel.hidden = !liveConnected;
  if (!liveConnected) return;
  const pending = (result.delivery || []).filter(
    (x) =>
      x.character === $("character").value &&
      (!x.inventorySent ||
        !x.loadoutSent ||
        (x.slot !== null && !x.buildApplied)),
  );
  const native = result.nativeRefresh;
  panel.textContent = native?.available
    ? "Live · Automatic inventory refresh connected. " +
      (native.builds
        ? "Build import is available. "
        : "Update the Live extension to enable build import. ") +
      "Reopen Equipment after saving."
    : "Live · Server connected. Automatic refresh is unavailable. " +
      (native?.reason || "");
  if (pending.length)
    panel.textContent +=
      " Waiting for game acknowledgement: " + pending.length + ".";
  else panel.textContent += " No pending delivery or build confirmation.";
  const name = selectedCharacter()?.name;
  $("connection").textContent = liveWritesReady
    ? "● Live · " + name + " · " + version()
    : "● Live server connected · waiting for the game character · " + version();
}
document.addEventListener("live-result", (event) => showLive(event.detail));
document.addEventListener("version-changed", () => {
  liveConnected = false;
  $("live-status").hidden = true;
});

function closeLiveReviews() {
  let closed = false;
  for (const dialog of document.querySelectorAll("dialog[open]")) {
    if (dialog.id === "settings-dialog") continue;
    dialog.close();
    closed = true;
  }
  return closed;
}

function markLiveLost(error) {
  liveConnected = false;
  liveWritesReady = false;
  connected = false;
  $("connection").textContent =
    "● Reconnecting · " +
    (selectedCharacter()?.name || "previous character") +
    " · " +
    version();
  $("live-status").hidden = false;
  $("live-status").textContent =
    "Waiting for the same game session. Your selection is retained; changes are paused. " +
    error.message;
  updateReview();
  refreshBuildButton();
  refreshPresetExportButton();
  document.dispatchEvent(new Event("live-state-changed"));
}

function refreshLiveNow({ allowPending = false } = {}) {
  if (!liveSessionRequested) return Promise.resolve(connected);
  if (livePollPromise) return livePollPromise;
  const generation = connectionGeneration,
    selected = version();
  livePollBusy = true;
  livePollPromise = (async () => {
    try {
      const result = await api("live-status", { version: selected });
      if (generation !== connectionGeneration || selected !== version())
        return false;
      if (!allowPending && (pending || buildBusy || addingSlots)) return false;
      const desired = LiveSession.selected(result, $("character").value);
      const changed =
        result.revision !== revision || desired !== $("character").value;
      if (changed) {
        const reviewed = closeLiveReviews();
        fillCharacters(result);
        if (reviewed)
          notice(
            "The character changed in game. Your selection is retained; review the latest data again.",
            true,
          );
      } else if (
        !connected ||
        liveWritesReady !== LiveSession.ready(result, desired)
      )
        fillCharacters(result);
      else showLive(result);
      return connected && liveWritesReady;
    } catch (error) {
      if (generation === connectionGeneration && selected === version())
        markLiveLost(error);
      return false;
    } finally {
      livePollBusy = false;
      livePollPromise = null;
    }
  })();
  return livePollPromise;
}

async function recoverStaleLive(error) {
  if (!liveSessionRequested || !/changed in game/.test(error.message))
    return false;
  await refreshLiveNow({ allowPending: true });
  notice(
    "The game updated this character. Your selection is retained; review the latest data again.",
    true,
  );
  return true;
}

async function discoverLiveCharacter() {
  if (
    !autoDiscoverLive ||
    connected ||
    liveSessionRequested ||
    discoveryBusy ||
    document.hidden
  )
    return;
  const generation = connectionGeneration;
  discoveryBusy = true;
  try {
    const result = await api("live-discover", { version: version() });
    if (
      generation !== connectionGeneration ||
      !autoDiscoverLive ||
      !result.live
    )
      return;
    if (result.version !== version()) {
      $("version").value = result.version;
      $("version").onchange();
    }
    autoDiscoverLive = false;
    fillCharacters(result);
    notice(
      "Connected to the character currently in game: " +
        selectedCharacter()?.name +
        ".",
    );
  } catch (error) {
    if (autoDiscoverLive) $("connection").textContent = "● " + error.message;
  } finally {
    discoveryBusy = false;
  }
}

document.addEventListener("settings-loaded", discoverLiveCharacter);
for (const action of ["install", "uninstall"]) {
  $("live-" + action).onclick = async () => {
    const selected = settingsVersion();
    $("live-install").disabled = $("live-uninstall").disabled = true;
    try {
      const result = await api("live-" + action, {
        version: selected,
        root: $("root").value.trim(),
      });
      $("live-settings-status").textContent = result.message;
    } catch (e) {
      $("live-settings-status").textContent = e.message;
    } finally {
      $("live-install").disabled = $("live-uninstall").disabled = false;
    }
  };
}
setInterval(async () => {
  if (!liveSessionRequested || pending || livePollBusy || document.hidden)
    return;
  await refreshLiveNow();
}, 2500);
setInterval(discoverLiveCharacter, 5000);
