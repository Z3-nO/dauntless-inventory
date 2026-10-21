"use strict";
const $ = (id) => document.getElementById(id);
const token = document.querySelector("meta[name=tool-token]").content;
let catalogs = {},
  characters = [],
  revision = "",
  selection = {},
  group = "",
  page = 0,
  connected = false,
  pending = false;
let noticeTimer;
let standardImages = {};
let directorySettings = {};
let directoryExamples = {};
let connectionGeneration = 0;
let liveConnected = false;
let liveSessionRequested = false;
let liveWritesReady = false;
let autoDiscoverLive = true;
const liveDrafts = new Map();
function showStandardImages() {
  const info = standardImages[$("settings-version").value];
  $("standard-images").textContent = info
    ? "Included previews: " +
      info.bundledAvailable +
      "/" +
      info.bundledAssociations +
      " associations" +
      (info.bundledMissing
        ? " · " + info.bundledMissing + " missing files"
        : "") +
      (info.nativeFound
        ? " | Original game textures: " +
          info.nativeRoot +
          " (" +
          info.archives +
          " Unreal archive files; export required for previews)."
        : " | Original game texture folder not found. Connect the full Forever folder to detect it.")
    : "Detecting included previews and original game texture paths…";
}
let imageRoots = {},
  imageRevision = Date.now();
const version = () => $("version").value;
const selectedCharacter = () =>
  characters.find((c) => c.id === $("character").value);
const label = (item) =>
  item.name === item.id ? item.id.replaceAll("_", " ") : item.name;
function notice(message, error = false) {
  clearTimeout(noticeTimer);
  $("status").textContent = message;
  $("status").className = error ? "error" : "";
  $("status").style.display = "block";
  noticeTimer = setTimeout(
    () => {
      $("status").style.display = "none";
    },
    error ? 14000 : 9000,
  );
}
async function api(route, data) {
  if (data && ["apply", "build-apply"].includes(route) && !data.id)
    data.id = crypto.randomUUID();
  const response = await fetch("/api/" + route, {
    method: data ? "POST" : "GET",
    headers: { "X-Tool-Token": token, "Content-Type": "application/json" },
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "Connection error.");
  return result;
}
function filtered() {
  const term = $("search").value.trim().toLowerCase(),
    items = selectedCharacter()?.items || {};
  return InventoryVisibility.catalog(catalogs, version()).filter(
    (x) =>
      (!group || x.group === group) &&
      (!term ||
        (x.name + " " + x.id + " " + x.description)
          .toLowerCase()
          .includes(term)) &&
      (!$("owned").checked || (items[x.id] || 0) > 0),
  );
}
function make(tag, text, cls) {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}
function groups() {
  $("groups").replaceChildren();
  for (const name of [
    "",
    ...new Set(
      InventoryVisibility.catalog(catalogs, version()).map((x) => x.group),
    ),
  ]) {
    const button = make(
      "button",
      name || "All items",
      group === name ? "active" : "",
    );
    button.onclick = () => {
      group = name;
      page = 0;
      groups();
      render();
    };
    $("groups").append(button);
  }
}
function render() {
  const list = filtered(),
    totalPages = Math.max(1, Math.ceil(list.length / 24));
  page = Math.min(page, totalPages - 1);
  $("group-title").textContent = group || "All items";
  $("count").textContent = list.length + " entries";
  $("cards").replaceChildren();
  for (const item of list.slice(page * 24, (page + 1) * 24)) {
    const card = make(
      "article",
      "",
      "card" + (Object.hasOwn(selection, item.id) ? " selected" : ""),
    );
    const preview = make("div", "", "preview"),
      image = new Image();
    image.alt = item.name;
    image.src =
      "/assets/" +
      encodeURIComponent(item.id) +
      ".png?version=" +
      version() +
      "&r=" +
      imageRevision;
    image.onerror = () =>
      preview.replaceChildren(make("span", "NO PREVIEW AVAILABLE"));
    preview.append(image);
    card.append(preview, make("h3", label(item)), make("code", item.id));
    const held = selectedCharacter()?.items[item.id];
    card.append(
      make(
        "div",
        connected
          ? "Owned: " + (held || 0).toLocaleString("en-US")
          : "No save connected",
        "quantity",
      ),
    );
    const button = make(
      "button",
      Object.hasOwn(selection, item.id) ? "Selected ✓" : "+ Select",
    );
    button.disabled = !item.editable;
    if (!item.editable) button.textContent = "Unverified format";
    button.onclick = () => {
      if (Object.hasOwn(selection, item.id)) delete selection[item.id];
      else
        selection[item.id] =
          item.singleton || item.storage === "instance" ? 1 : 100;
      render();
      basket();
    };
    const upload = make("input");
    upload.type = "file";
    upload.accept = ".png,.jpg,.jpeg,.webp";
    upload.hidden = true;
    const attach = make("button", "Choose preview", "image-attach");
    attach.onclick = () => upload.click();
    upload.onchange = async () => {
      const file = upload.files[0];
      if (!file) return;
      if (file.size > 8000000)
        return notice("Image too large: 8 MB maximum.", true);
      const targetVersion = version();
      attach.disabled = true;
      try {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.onerror = () => reject(Error("Could not read the image."));
          reader.readAsDataURL(file);
        });
        await api("image-import", {
          version: targetVersion,
          id: item.id,
          base64,
        });
        imageRevision = Date.now();
        render();
        notice("Preview linked to " + label(item));
      } catch (e) {
        notice(e.message, true);
      } finally {
        attach.disabled = false;
      }
    };
    card.append(button, attach, upload);
    $("cards").append(card);
  }
  if (!list.length)
    $("cards").append(make("p", "No items match your search.", "empty"));
  $("page").textContent = page + 1 + " / " + totalPages;
  $("prev").disabled = page === 0;
  $("next").disabled = page >= totalPages - 1;
}
function basket() {
  $("selection").replaceChildren();
  const ids = Object.keys(selection);
  $("basket-count").textContent = ids.length;
  for (const id of ids) {
    const item = catalogs[version()].find((x) => x.id === id),
      row = make("div", "", "basket-row");
    row.append(make("strong", label(item)));
    const line = make("div", "", "connect-row"),
      input = make("input");
    input.type = "number";
    input.min = item.singleton || item.storage === "instance" ? "1" : "0";
    input.max =
      item.singleton || item.storage === "instance" ? "1" : "99999999";
    input.value = selection[id];
    input.disabled = item.singleton || item.storage === "instance";
    input.setAttribute("aria-label", "Quantity " + label(item));
    input.oninput = () => {
      selection[id] = input.value === "" ? NaN : Number(input.value);
      updateReview();
    };
    const remove = make("button", "×");
    remove.setAttribute("aria-label", "Remove " + label(item));
    remove.onclick = () => {
      delete selection[id];
      basket();
      render();
    };
    line.append(input, remove);
    row.append(line);
    $("selection").append(row);
  }
  if (!ids.length)
    $("selection").append(
      make("p", "Select an item from the catalogue to begin.", "empty"),
    );
  updateReview();
}
function updateReview() {
  $("review").disabled =
    pending ||
    !connected ||
    (liveConnected && !liveWritesReady) ||
    !selectedCharacter() ||
    !Object.keys(selection).length ||
    Object.values(selection).some(
      (n) => !Number.isSafeInteger(n) || n < 0 || n > 99999999,
    );
}
function fillCharacters(result) {
  const old = $("character").value;
  const previous = selectedCharacter();
  const controls = ["build-slot", "slot-source", "preset-export-slot"];
  const savedControls = Object.fromEntries(
    controls.map((id) => [id, $(id)?.value]),
  );
  characters = result.characters;
  revision = result.revision;
  const desired = result.live
    ? LiveSession.selected(result, old)
    : characters.some((ch) => ch.id === old)
      ? old
      : characters[0]?.id;
  if (result.live && desired !== old && old) {
    liveDrafts.set(old, structuredClone(selection));
    selection = liveDrafts.get(desired) || {};
    basket();
  }
  $("character").replaceChildren();
  if (result.live && !desired) {
    const waiting = make("option", "Waiting for the in-game character");
    waiting.value = "";
    $("character").append(waiting);
  }
  for (const ch of characters) {
    const option = make("option", ch.name);
    option.value = ch.id;
    $("character").append(option);
  }
  $("character").value = desired || "";
  $("character").disabled = result.live || !characters.length;
  liveWritesReady = result.live ? LiveSession.ready(result, desired) : false;
  connected = !!characters.length && (!result.live || liveWritesReady);
  $("connection").textContent = connected
    ? "● Local save connected · " + version()
    : "● No characters in this save";
  const current = selectedCharacter();
  const changed =
    old !== desired ||
    JSON.stringify(previous?.slots) !== JSON.stringify(current?.slots) ||
    JSON.stringify(previous?.slotInfo) !== JSON.stringify(current?.slotInfo);
  if (changed) {
    document.dispatchEvent(new Event("character-changed"));
    if (old === desired) {
      for (const id of controls) {
        const control = $(id),
          value = savedControls[id];
        if (
          control &&
          [...control.options].some((option) => option.value === value)
        )
          control.value = value;
      }
      if (typeof refreshBuildButton === "function") refreshBuildButton();
      if (typeof refreshPresetExportButton === "function")
        refreshPresetExportButton();
    }
  }
  document.dispatchEvent(new CustomEvent("live-result", { detail: result }));
  render();
  updateReview();
}
function disconnectCharacter() {
  connectionGeneration++;
  connected = false;
  liveSessionRequested = false;
  liveConnected = false;
  liveWritesReady = false;
  autoDiscoverLive = false;
  liveDrafts.clear();
  characters = [];
  revision = "";
  selection = {};
  group = "";
  page = 0;
  $("owned").checked = false;
  $("character").replaceChildren(make("option", "Connect a save"));
  $("character").disabled = true;
  $("connection").textContent = "● Catalogue · no save connected";
  groups();
  render();
  basket();
  document.dispatchEvent(new Event("character-changed"));
}
$("version").onchange = disconnectCharacter;
$("connect").onclick = async () => {
  autoDiscoverLive = false;
  const targetVersion = version();
  const generation = ++connectionGeneration;
  $("connect").disabled = true;
  try {
    const result = await api("connect", {
      version: targetVersion,
    });
    if (generation !== connectionGeneration || targetVersion !== version())
      return;
    if (result.standardImages)
      standardImages[targetVersion] = result.standardImages;
    showStandardImages();
    fillCharacters(result);
    notice(
      connected
        ? "Character connected. You can prepare your changes."
        : "No characters available.",
    );
  } catch (e) {
    if (generation !== connectionGeneration || targetVersion !== version())
      return;
    disconnectCharacter();
    characters = [];
    revision = "";
    $("character").replaceChildren(make("option", "Connection failed"));
    $("character").disabled = true;
    $("connection").textContent = "● Connection failed";
    render();
    updateReview();
    notice(e.message, true);
  } finally {
    $("connect").disabled = false;
  }
};
$("character").onchange = () => {
  render();
  updateReview();
  document.dispatchEvent(new Event("character-changed"));
};
for (const id of ["search", "owned"])
  $(id).oninput = () => {
    page = 0;
    render();
  };
$("prev").onclick = () => {
  page--;
  render();
};
$("next").onclick = () => {
  page++;
  render();
};
$("clear").onclick = () => {
  selection = {};
  basket();
  render();
};
$("bulk").onclick = () => {
  const n = Number($("bulk-quantity").value);
  if (
    !$("bulk-quantity").value ||
    !Number.isSafeInteger(n) ||
    n < 0 ||
    n > 99999999
  )
    return notice("Enter a whole number between 0 and 99,999,999.", true);
  for (const item of filtered())
    if (item.editable)
      selection[item.id] =
        item.singleton || item.storage === "instance" ? 1 : n;
  basket();
  render();
};
$("review").onclick = async () => {
  if (liveSessionRequested && !(await refreshLiveNow())) return;
  const who = selectedCharacter();
  if (!who) return;
  $("summary").textContent =
    "Character: " +
    who.name +
    " · Version: " +
    version() +
    ". " +
    Object.keys(selection).length +
    " items. Operation: " +
    ($("mode").value === "add"
      ? "add to owned quantities."
      : "set final totals.") +
    ($("maximize").checked && version() === "1.14.7"
      ? " Power Surge all owned copies of the selected equipment. Slots using that equipment will reflect the upgrade."
      : "");
  $("confirm").showModal();
};
$("cancel").onclick = () => $("confirm").close();
$("apply").onclick = async () => {
  if (pending) return;
  pending = true;
  $("apply").disabled = true;
  updateReview();
  try {
    const result = await api("apply", {
      version: version(),
      character: $("character").value,
      revision,
      mode: $("mode").value,
      changes: selection,
      maximize: $("maximize").checked,
    });
    selection = {};
    fillCharacters(result);
    basket();
    $("confirm").close();
    notice(
      (result.live ? result.message : "Inventory updated.") +
        " Backup: " +
        result.backup,
    );
  } catch (e) {
    $("confirm").close();
    if (!(await recoverStaleLive(e))) notice(e.message, true);
  } finally {
    pending = false;
    $("apply").disabled = false;
    updateReview();
  }
};
const oldVersionChange = $("version").onchange;
$("version").onchange = () => {
  oldVersionChange();
  showStandardImages();
  $("image-root").value = imageRoots[version()] || "";
  $("image-report").textContent =
    "Available equipment icons from the Builder are included. You can link more local images.";
  $("maximize").checked = true;
  $("maximize").disabled = false;
  $("maximize-option").hidden = false;
  document.dispatchEvent(new Event("version-changed"));
  document.dispatchEvent(new Event("character-changed"));
};
api("catalog")
  .then((data) => {
    catalogs = data.catalogs;
    imageRoots = data.imageRoots || {};
    directorySettings = data.directories || {};
    directoryExamples = data.directoryExamples || {};
    standardImages = data.standardImages || {};
    showStandardImages();
    $("image-root").value = imageRoots[version()] || "";
    document.dispatchEvent(new Event("settings-loaded"));
    groups();
    render();
    basket();
  })
  .catch((e) => notice(e.message, true));
