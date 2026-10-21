// Shared display rules. Save validation remains enforced by the backend.
(function (root) {
  const policy = {
    catalog(catalogs, version) {
      return (catalogs[version] || []).filter((item) => item.editable === true);
    },
    slots(character) {
      return (character?.slots || []).filter(
        (slot) => slot.saved !== false && slot.available !== false,
      );
    },
    canAdd(character, live) {
      return !live && character?.slotInfo?.canAdd === true;
    },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = policy;
  else root.InventoryVisibility = policy;
})(globalThis);
