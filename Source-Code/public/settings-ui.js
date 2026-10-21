"use strict";

const settingsVersion = () => $("settings-version").value;
let savingDirectories = false;
let scanningImages = false;

function showDirectorySettings() {
  const selected = settingsVersion();
  const saved = directorySettings[selected] || {};
  const example = directoryExamples[selected] || {};
  $("data-path-example").textContent =
    example.dataRoot || "Forever / versions / " + selected;
  $("game-path-example").textContent =
    example.gameDir || "Choose the folder containing Archon";
  $("texture-path-example").textContent =
    example.textures || "Game folder / Archon / Content / Paks";
  $("root").placeholder =
    example.dataRoot || "Select the Forever folder containing your saves";
  $("game-root").placeholder =
    example.gameDir || "Select the game folder containing Archon";

  $("root").value = saved.dataRoot || "";
  $("game-root").value = saved.gameDir || "";
  $("image-root").value = imageRoots[selected] || "";
  $("settings-status").textContent = "";
  $("image-report").textContent =
    "Builder equipment icons are included. Optional exported PNG, JPEG and WebP images can be linked below.";
  showStandardImages();
}

$("open-settings").onclick = () => {
  $("settings-version").value = version();
  showDirectorySettings();
  $("settings-dialog").showModal();
};
$("close-settings").onclick = () => $("settings-dialog").close();
$("settings-version").onchange = showDirectorySettings;
$("use-directory-examples").onclick = async () => {
  const selected = settingsVersion();
  const button = $("use-directory-examples");
  button.disabled = true;
  $("settings-version").disabled = true;
  try {
    const found = await api("directories-find", { version: selected });
    $("settings-status").className = "hint";
    if (!found.dataRoot) {
      $("settings-status").textContent =
        "No save found in the standard Forever folders. Choose your folders manually, or create a character in Forever first.";
      return;
    }
    $("root").value = found.dataRoot;
    $("game-root").value = found.gameDir;
    $("settings-status").textContent = found.gameDir
      ? "Folders found. Save directories to keep this selection."
      : "Save folder found. Choose the game installation folder manually.";
  } catch (error) {
    $("settings-status").className = "hint error";
    $("settings-status").textContent = error.message;
  } finally {
    button.disabled = false;
    $("settings-version").disabled = false;
  }
};
document.addEventListener("settings-loaded", showDirectorySettings);

$("save-settings").onclick = async () => {
  if (savingDirectories) return;
  savingDirectories = true;
  $("save-settings").disabled = true;
  $("settings-version").disabled = true;
  const selected = settingsVersion();
  try {
    const result = await api("settings", {
      version: selected,
      dataRoot: $("root").value.trim(),
      gameDir: $("game-root").value.trim(),
    });
    directorySettings[selected] = result.directories;
    standardImages[selected] = result.standardImages;
    // A directory change requires an explicit reconnect, preventing writes to the old save.
    if (selected === version()) disconnectCharacter();
    if (selected === settingsVersion()) {
      $("settings-status").className = "hint";
      $("settings-status").textContent =
        "Directories saved for " +
        selected +
        ". Close Settings and connect your character.";
      showStandardImages();
    }
  } catch (error) {
    $("settings-status").className = "hint error";
    $("settings-status").textContent = error.message;
  } finally {
    savingDirectories = false;
    $("save-settings").disabled = false;
    $("settings-version").disabled = false;
  }
};

$("scan-images").onclick = async () => {
  if (scanningImages) return;
  scanningImages = true;
  $("scan-images").disabled = true;
  const selected = settingsVersion();
  try {
    const report = await api("images", {
      version: selected,
      root: $("image-root").value.trim(),
    });
    imageRoots[selected] = report.root;
    if (selected === settingsVersion()) {
      $("image-report").textContent =
        report.images +
        " images found · " +
        report.matched +
        " items matched · " +
        report.ambiguous +
        " ambiguous matches. " +
        report.message;
    }
    imageRevision = Date.now();
    render();
  } catch (error) {
    if (selected === settingsVersion())
      $("image-report").textContent = error.message;
  } finally {
    scanningImages = false;
    $("scan-images").disabled = false;
  }
};

// The desktop bridge exposes only the native directory picker.
if (window.desktop) {
  for (const id of ["root", "game-root", "image-root"]) {
    const browse = make("button", "Browse…");
    browse.type = "button";
    browse.onclick = async () => {
      const selected = settingsVersion();
      const chosen = await window.desktop.chooseFolder();
      if (chosen && selected === settingsVersion()) $(id).value = chosen;
    };
    $(id).parentElement.append(browse);
  }
}
