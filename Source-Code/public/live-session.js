"use strict";
(function (root, factory) {
  const policy = factory();
  if (typeof module === "object" && module.exports) module.exports = policy;
  else root.LiveSession = policy;
})(typeof window === "object" ? window : globalThis, function () {
  function gameCharacter(result) {
    const native = result.nativeRefresh;
    if (!result.live || !native?.available || native.connections !== 1)
      return null;
    const active = result.gameCharacter || result.activeCharacter;
    return result.characters?.some((character) => character.id === active)
      ? active
      : null;
  }
  function selected(result, previous) {
    return (
      gameCharacter(result) ||
      (result.characters?.some((character) => character.id === previous)
        ? previous
        : null)
    );
  }
  function ready(result, selectedId) {
    return !!selectedId && gameCharacter(result) === selectedId;
  }
  return { gameCharacter, selected, ready };
});
