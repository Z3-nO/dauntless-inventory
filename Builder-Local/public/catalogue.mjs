// Show verified player items for the selected version.
export function visibleCatalogue(catalogues, version) {
  return (catalogues[version] || []).filter((item) => item.editable === true);
}

export function setupCatalogue({
  catalogues,
  datasets,
  getVersion,
  image,
  selectGear,
}) {
  const $ = (id) => document.getElementById(id);
  let page = 0,
    lastVersion = "";
  const size = 30;
  const make = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  function plannerItem(item) {
    const data = datasets[getVersion()];
    for (const category of [
      "weapons",
      "armours",
      "lanterns",
      "cells",
      "parts",
      "omnicells",
    ]) {
      const matches = data[category]
        .map((gear, index) => ({ gear, index, category }))
        .filter(({ gear }) => gear.catalogId === item.id);
      if (matches.length === 1) return matches[0];
    }
    return null;
  }
  function render() {
    const version = getVersion(),
      items = visibleCatalogue(catalogues, version);
    if (lastVersion !== version) {
      page = 0;
      lastVersion = version;
      $("catalogue-search").value = "";
      $("catalogue-new").checked = false;
      $("catalogue-group").replaceChildren();
      for (const group of ["", ...new Set(items.map((item) => item.group))]) {
        const option = make("option", group || "All categories");
        option.value = group;
        $("catalogue-group").append(option);
      }
    }
    $("catalogue-new").disabled = version !== "1.14.7";
    const query = $("catalogue-search").value.trim().toLowerCase(),
      group = $("catalogue-group").value;
    const filtered = items.filter(
      (item) =>
        (!group || item.group === group) &&
        (!query || (item.name + " " + item.id).toLowerCase().includes(query)) &&
        (!$("catalogue-new").checked || item.newIdentifier),
    );
    const pages = Math.max(1, Math.ceil(filtered.length / size));
    page = Math.min(page, pages - 1);
    $("catalogue-count").textContent =
      filtered.length.toLocaleString("en-GB") +
      " / " +
      items.length.toLocaleString("en-GB") +
      " entries";
    $("catalogue-items").replaceChildren();
    for (const item of filtered.slice(page * size, (page + 1) * size)) {
      const card = make("article", "", "catalogue-item"),
        found = plannerItem(item),
        heading = make("h3", item.name);
      if (found?.gear.icon) {
        const holder = make("span");
        holder.innerHTML = image(found.gear.icon, "gico");
        heading.prepend(holder);
      }
      card.append(
        heading,
        make("span", item.group, "note"),
        make("code", item.id),
      );
      if (item.newIdentifier)
        card.append(make("span", "New identifier since 1.6.2", "new-tag"));
      if (
        found &&
        ["weapons", "armours", "lanterns", "omnicells"].includes(found.category)
      ) {
        const button = make("button", "Use in build", "btn");
        button.onclick = () => {
          selectGear(found);
          $("tab-planner").click();
        };
        card.append(button);
      }
      $("catalogue-items").append(card);
    }
    if (!filtered.length)
      $("catalogue-items").append(
        make("p", "No items match your search.", "empty-note"),
      );
    $("catalogue-page").textContent = page + 1 + " / " + pages;
    $("catalogue-prev").disabled = page === 0;
    $("catalogue-next").disabled = page === pages - 1;
  }
  for (const id of ["catalogue-search", "catalogue-group", "catalogue-new"])
    $(id).addEventListener("input", () => {
      page = 0;
      render();
    });
  $("catalogue-prev").onclick = () => {
    page--;
    render();
  };
  $("catalogue-next").onclick = () => {
    page++;
    render();
  };
  for (const name of ["planner", "catalogue"])
    $("tab-" + name).onclick = () => {
      $("planner-view").hidden = name !== "planner";
      $("catalogue-view").hidden = name !== "catalogue";
      for (const other of ["planner", "catalogue"]) {
        $("tab-" + other).classList.toggle("on", other === name);
        $("tab-" + other).setAttribute("aria-pressed", String(other === name));
      }
      if (name === "catalogue") render();
    };
  return render;
}
