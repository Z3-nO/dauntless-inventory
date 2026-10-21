"use strict";
let addingSlots = false;
const slotDialog = document.createElement("dialog");
document.body.append(slotDialog);
function refreshSlotManagement(event) {
  const character = selectedCharacter(),
    info = character?.slotInfo;
  $("slot-counts").textContent = info
    ? info.saved +
      " equipment presets saved. " +
      (liveConnected
        ? "Close the game and server before creating more presets."
        : info.canAdd
          ? "You can create up to " + (info.limit - info.saved) + " more."
          : "All currently available presets are already created.")
    : "Connect your character to see how many equipment presets it has.";
  $("slot-options").hidden = !InventoryVisibility.canAdd(
    character,
    liveConnected,
  );
  if ($("slot-options").hidden) $("slot-options").open = false;
  $("slot-source").replaceChildren(
    make("option", "Choose an existing slot to copy"),
  );
  $("slot-source").firstElementChild.value = "";
  for (const slot of character?.slots || []) {
    if (!slot.saved) continue;
    const option = make(
      "option",
      "Slot " + (slot.index + 1) + " · " + slot.name,
    );
    option.value = String(slot.index);
    $("slot-source").append(option);
  }
  $("slot-source").disabled = !info?.canAdd;
  $("slots-to-add").disabled = !info?.canAdd;
  $("slots-to-add").max =
    info?.limit == null ? "0" : String(Math.max(0, info.limit - info.saved));
  refreshAddSlots();
  if (event?.type !== "live-state-changed") refreshPresetExport();
}
function refreshAddSlots() {
  $("add-slots-review").disabled =
    addingSlots ||
    !connected ||
    !selectedCharacter()?.slotInfo?.canAdd ||
    $("slot-source").value === "" ||
    !Number.isSafeInteger(Number($("slots-to-add").value)) ||
    Number($("slots-to-add").value) < 1 ||
    Number($("slots-to-add").value) > Number($("slots-to-add").max);
}
document.addEventListener("character-changed", refreshSlotManagement);
document.addEventListener("version-changed", refreshSlotManagement);
document.addEventListener("live-state-changed", refreshSlotManagement);
$("slot-source").onchange = refreshAddSlots;
$("slots-to-add").oninput = refreshAddSlots;
$("add-slots-review").onclick = () => {
  if ($("add-slots-review").disabled) return;
  const character = selectedCharacter();
  const request = {
    version: version(),
    character: character.id,
    revision,
    sourceSlot: Number($("slot-source").value),
    count: Number($("slots-to-add").value),
  };
  slotDialog.replaceChildren(
    make("h2", "Add " + request.count + " loadout slot(s)"),
    make(
      "p",
      character.name +
        " · " +
        request.version +
        " · copy slot " +
        (request.sourceSlot + 1),
    ),
    make(
      "p",
      "A complete save backup will be created. Existing slots, equipped items and the active slot will be preserved. New slots share the copied equipment; no items are duplicated.",
    ),
  );
  const cancel = make("button", "Cancel"),
    apply = make("button", "Back up and add slots", "primary");
  cancel.onclick = () => slotDialog.close();
  apply.onclick = async () => {
    if (addingSlots) return;
    addingSlots = true;
    apply.disabled = true;
    refreshAddSlots();
    try {
      const result = await api("slots-add", request);
      fillCharacters(result);
      slotDialog.close();
      notice("Slots added. Backup: " + result.backup);
    } catch (error) {
      slotDialog.close();
      notice(error.message, true);
    } finally {
      addingSlots = false;
      refreshAddSlots();
    }
  };
  const actions = make("div", "", "connect-row");
  actions.append(cancel, apply);
  slotDialog.append(actions);
  slotDialog.showModal();
};
// Export never writes to the character or changes the active in-game preset.
let presetExport = null;
let presetExportGeneration = 0;
let presetExportBusy = false;
function clearPresetExport() {
  presetExportGeneration++;
  presetExport = null;
  $("preset-export-code").value = "";
  $("preset-export-result").hidden = true;
}
function refreshPresetExport() {
  clearPresetExport();
  const select = $("preset-export-slot"),
    previous = select.value;
  select.replaceChildren(make("option", "Choose the in-game preset to export"));
  select.firstElementChild.value = "";
  for (const slot of InventoryVisibility.slots(selectedCharacter())) {
    const option = make(
      "option",
      "Slot " + (slot.index + 1) + " · " + slot.name,
    );
    option.value = String(slot.index);
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === previous))
    select.value = previous;
  select.disabled = !connected || select.options.length === 1;
  refreshPresetExportButton();
}
function refreshPresetExportButton() {
  $("preset-export-generate").disabled =
    presetExportBusy ||
    !connected ||
    !selectedCharacter() ||
    $("preset-export-slot").value === "";
}
$("preset-export-slot").onchange = () => {
  clearPresetExport();
  refreshPresetExportButton();
};
$("preset-export-generate").onclick = async () => {
  if ($("preset-export-generate").disabled) return;
  clearPresetExport();
  const generation = presetExportGeneration;
  const request = {
    version: version(),
    character: selectedCharacter().id,
    slot: Number($("preset-export-slot").value),
  };
  presetExportBusy = true;
  refreshPresetExportButton();
  try {
    const result = await api("build-export", request);
    if (
      generation !== presetExportGeneration ||
      version() !== request.version ||
      selectedCharacter()?.id !== request.character
    )
      return;
    presetExport = result;
    $("preset-export-code").value = result.code;
    $("preset-export-summary").textContent =
      result.version +
      " · Slot " +
      (result.slot + 1) +
      " · " +
      result.summary.weapon +
      " · " +
      result.summary.cells +
      " cells" +
      (result.summary.omnicell ? " · " + result.summary.omnicell : "") +
      (result.summary.bond ? " · Bond: " + result.summary.bond : "");
    $("preset-export-result").hidden = false;
    notice(
      "Build exported from the saved preset. Your character was not changed.",
    );
  } catch (error) {
    if (generation === presetExportGeneration)
      notice(
        error.message === "Unknown live operation."
          ? "Update the Live connection in Settings, restart the local server, then export again. You can also export with the game and server closed."
          : error.message,
        true,
      );
  } finally {
    presetExportBusy = false;
    refreshPresetExportButton();
  }
};
$("preset-export-copy").onclick = async () => {
  if (!presetExport) return;
  try {
    await navigator.clipboard.writeText(presetExport.code);
    notice("Builder code copied.");
  } catch {
    $("preset-export-code").focus();
    $("preset-export-code").select();
    notice("Code selected. Press Ctrl+C to copy it.");
  }
};
$("preset-export-download").onclick = () => {
  if (!presetExport) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(presetExport.file, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download =
    "dauntless-" +
    presetExport.version +
    "-slot-" +
    (presetExport.slot + 1) +
    ".dfbuild.json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
refreshSlotManagement();
