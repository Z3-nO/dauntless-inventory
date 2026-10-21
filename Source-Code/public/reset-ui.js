"use strict";
let resettingCharacter = false;
let resetLookup = 0;
const resetDialog = document.createElement("dialog");
resetDialog.setAttribute("aria-label", "Character reset and restore");
document.body.append(resetDialog);

async function refreshResetControls() {
  const generation = ++resetLookup;
  const character = selectedCharacter();
  $("reset-target").textContent =
    connected && character
      ? "Connected character: " + character.name + " · " + version()
      : "Connect a character first.";
  $("reset-review").disabled = resettingCharacter || !connected || !character;
  $("restore-review").disabled = true;
  $("reset-backup").disabled = true;
  $("reset-backup").replaceChildren(
    make(
      "option",
      character ? "Loading backups…" : "Connect a character first",
    ),
  );
  $("reset-backup").firstElementChild.value = "";
  if (!connected || !character) return;
  try {
    const points = await api("reset-backups", {
      version: version(),
      character: character.id,
    });
    if (generation !== resetLookup) return;
    $("reset-backup").replaceChildren(
      make(
        "option",
        points.length
          ? "Choose a before-reset backup"
          : "No character reset yet",
      ),
    );
    $("reset-backup").firstElementChild.value = "";
    for (const point of points) {
      const option = make(
        "option",
        new Date(point.created).toLocaleString() + " · " + point.name,
      );
      option.value = point.id;
      $("reset-backup").append(option);
    }
    $("reset-backup").disabled = resettingCharacter || !points.length;
  } catch (error) {
    if (generation === resetLookup)
      $("reset-status").textContent = error.message;
  }
}

$("reset-backup").onchange = () => {
  $("restore-review").disabled = resettingCharacter || !$("reset-backup").value;
};
document.addEventListener("character-changed", refreshResetControls);

function reviewCharacterReset(restore) {
  const character = selectedCharacter();
  if (!connected || !character || resettingCharacter || pending) return;
  const request = {
    version: version(),
    character: character.id,
    revision,
    backupId: restore ? $("reset-backup").value : undefined,
  };
  if (restore && !request.backupId) return;
  $("settings-dialog").close();
  resetDialog.replaceChildren(
    make("h2", restore ? "Restore character" : "Reset character"),
    make("p", character.name + " · " + request.version),
    make(
      "p",
      restore
        ? "Restore this character to the selected before-reset backup. The current save will also be backed up. Other characters and shared account progress stay unchanged."
        : "Remove this character's inventory and character quest progress, and replace every loadout with starter equipment. A before-reset backup will be saved. Name, appearance, shared account progress and other characters stay unchanged.",
    ),
  );
  const label = make("label", "Type the character name to confirm");
  const input = make("input");
  input.id = "reset-confirm-name";
  input.autocomplete = "off";
  label.htmlFor = input.id;
  const cancel = make("button", "Cancel");
  const apply = make(
    "button",
    restore ? "Back up and restore character" : "Back up and reset character",
    "primary",
  );
  const status = make("p", "", "hint");
  apply.disabled = true;
  input.oninput = () => {
    apply.disabled = resettingCharacter || input.value !== character.name;
  };
  cancel.onclick = () => resetDialog.close();
  apply.onclick = async () => {
    if (resettingCharacter || pending || input.value !== character.name) return;
    resettingCharacter = true;
    pending = true;
    apply.disabled = true;
    cancel.disabled = true;
    updateReview();
    try {
      const result = await api(
        restore ? "restore-character" : "reset-character",
        { ...request, confirmName: input.value },
      );
      selection = {};
      fillCharacters(result);
      basket();
      resetDialog.close();
      notice(
        (restore
          ? "Character restored."
          : "Character reset. Restore is available in Settings.") +
          " Backup: " +
          result.backup,
      );
    } catch (error) {
      status.textContent = error.message;
      status.className = "hint error";
    } finally {
      resettingCharacter = false;
      pending = false;
      cancel.disabled = false;
      apply.disabled = input.value !== character.name;
      updateReview();
      refreshResetControls();
    }
  };
  const actions = make("div", "", "connect-row");
  actions.append(cancel, apply);
  resetDialog.append(label, input, status, actions);
  resetDialog.showModal();
}
$("reset-review").onclick = () => reviewCharacterReset(false);
$("restore-review").onclick = () => reviewCharacterReset(true);
refreshResetControls();
