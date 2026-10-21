// Build import UI. It never chooses a loadout slot on behalf of the user.
"use strict";
let currentPlan = null;
let previewedCode = "";
let buildBusy = false;
const buildDialog = document.createElement("dialog");
document.body.append(buildDialog);

function refreshBuildButton() {
  $("build-file-button").disabled = buildBusy;
  $("build-review").disabled =
    buildBusy ||
    !connected ||
    (liveConnected && !liveWritesReady) ||
    !selectedCharacter() ||
    !currentPlan?.compatible ||
    $("build-slot").value === "";
}

function refreshSlots() {
  $("build-slot").replaceChildren();
  const placeholder = make("option", "Choose a slot — no automatic selection");
  placeholder.value = "";
  $("build-slot").append(placeholder);
  for (const slot of InventoryVisibility.slots(selectedCharacter())) {
    const option = make(
      "option",
      "Slot " + (slot.index + 1) + " · " + slot.name,
    );
    option.value = String(slot.index);
    $("build-slot").append(option);
  }
  $("build-slot").disabled =
    !InventoryVisibility.slots(selectedCharacter()).length;
  refreshBuildButton();
}

document.addEventListener("character-changed", refreshSlots);
document.addEventListener("version-changed", () => {
  $("build-code").value = "";
  $("build-code").placeholder = "Paste a " + version() + " build code";
  $("build-format-hint").textContent =
    "Choose a build for " +
    version() +
    ", then select the equipment preset to replace.";
  $("build-file-name").textContent =
    "No file selected · " + version() + " builds";
  currentPlan = null;
  previewedCode = "";
  $("build-result").replaceChildren();
  refreshBuildButton();
});
$("build-slot").onchange = refreshBuildButton;
$("build-code").oninput = () => {
  $("build-file-name").textContent =
    "No file selected · paste a code or choose a build file";
  currentPlan = null;
  refreshBuildButton();
};
$("build-file-button").onclick = () => $("build-file").click();
$("build-file").onchange = async () => {
  try {
    const file = $("build-file").files[0];
    if (!file) return;
    if (file.size > 65536) throw Error("Build file is too large.");
    const record = JSON.parse(await file.text());
    if (
      record.format !== "dauntless-local-build" ||
      record.schema !== 1 ||
      record.version !== version() ||
      typeof record.code !== "string"
    )
      throw Error("Choose a valid build file for the selected game version.");
    $("build-code").value = record.code;
    $("build-code").dispatchEvent(new Event("input"));
    $("build-file-name").textContent = file.name;
    $("build-preview").click();
  } catch (error) {
    notice(error.message, true);
  } finally {
    $("build-file").value = "";
  }
};

$("build-preview").onclick = async () => {
  currentPlan = null;
  buildBusy = true;
  $("build-preview").disabled = true;
  refreshBuildButton();
  const targetVersion = version();
  const code = $("build-code").value.trim();
  try {
    const plan = await api("build-preview", { code, version: targetVersion });
    if (version() !== targetVersion || $("build-code").value.trim() !== code)
      return;
    currentPlan = plan;
    previewedCode = code;
    $("build-result").replaceChildren(make("p", plan.note, "hint"));
    const list = make("div", "", "build-components");
    for (const component of [...plan.gear, ...plan.cells, ...plan.parts]) {
      const row = make("div", "", "build-component");
      const image = new Image();
      image.src =
        "/assets/" +
        encodeURIComponent(component.id) +
        ".png?version=" +
        targetVersion;
      image.alt = "";
      image.onerror = () => image.remove();
      row.append(
        image,
        make("span", component.name),
        make(
          "small",
          component.rank
            ? "+" + component.rank
            : component.level != null
              ? "Level " + component.level
              : "",
        ),
      );
      list.append(row);
    }
    $("build-result").append(list);
    for (const issue of plan.issues)
      $("build-result").append(make("p", issue, "build-issue"));
  } catch (error) {
    notice(error.message, true);
  } finally {
    buildBusy = false;
    $("build-preview").disabled = false;
    refreshBuildButton();
  }
};

$("build-review").onclick = async () => {
  if (liveSessionRequested && !(await refreshLiveNow())) return;
  if ($("build-review").disabled) return;
  const character = selectedCharacter();
  const slotIndex = Number($("build-slot").value);
  const slot = character.slots.find((slot) => slot.index === slotIndex);
  if (!slot) return;
  // Capture all reviewed values; changing another UI control cannot redirect this write.
  const reviewed = {
    version: version(),
    character: character.id,
    revision,
    buildCode: previewedCode,
    slot: slotIndex,
  };
  buildDialog.replaceChildren(
    make("h2", "Import into slot " + (slotIndex + 1)),
  );
  buildDialog.append(
    make("p", character.name + " · " + reviewed.version + " · " + slot.name),
  );
  buildDialog.append(
    make(
      "p",
      "Only this loadout will be updated. Other slots will be preserved. Build items will be granted or upgraded and cells will be slotted. A full backup will be created first.",
    ),
  );
  const actions = make("div", "", "connect-row");
  const cancel = make("button", "Cancel");
  const apply = make(
    "button",
    "Back up and import into slot " + (slotIndex + 1),
    "primary",
  );
  cancel.onclick = () => buildDialog.close();
  apply.onclick = async () => {
    if (buildBusy) return;
    buildBusy = true;
    apply.disabled = true;
    refreshBuildButton();
    try {
      const result = await api("build-apply", reviewed);
      fillCharacters(result);
      buildDialog.close();
      notice(
        "Build imported into slot " +
          (slotIndex + 1) +
          (result.live ? ". " + result.message + " Backup: " : ". Backup: ") +
          result.backup,
      );
    } catch (error) {
      buildDialog.close();
      if (!(await recoverStaleLive(error))) notice(error.message, true);
    } finally {
      buildBusy = false;
      refreshBuildButton();
    }
  };
  actions.append(cancel, apply);
  buildDialog.append(actions);
  buildDialog.showModal();
};
