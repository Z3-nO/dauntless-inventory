# Verification — 20 October 2026

## Automated checks

Nine automated tests pass. They cover:

- Exact legacy `162.` code roundtrip with the original public example and URL/hash import.
- Modern stable-key code roundtrip, with omnicell, bond, mods and all seven cells retained.
- Rejection of unknown versions/items, wrong armour slots, incompatible parts/bonds/cells, invalid ranks and unsupported upgrade levels.
- Export/import roundtrips for all 231 modern weapons and 139 modern armour pieces at supported data levels.
- Preservation of every legacy planner record, distinct Reforged balance/perk data, no unresolved description templates.
- All 7,112/5,805 catalogue entries retained, including every identifier absent from the older catalogue.
- All planner icons available locally; local font references without network URLs.
- Read-only local HTTP serving, nonlocal Host rejection, path traversal protection and no runtime download/save-writing endpoint.

Output: `Verification-tests.txt`. Tests use the included Node runtime and temporary HTTP ports. No original game files are modified.

## Browser checks completed

- Compared the original online Builder with the local rendering: typography, palette, panels, rack, perk ledger and card design retained.
- Switched between both versions and verified separate remembered builds/names.
- Saved and reloaded a named build from the browser library.
- Exported a 1.14.7 JSON build file, started empty and imported the downloaded file successfully.
- Imported both included example files; the selected version switched automatically.
- Exported and loaded a modern code with Cyclonic Fury, Sahvyt's Cutlass bond and Discipline omnicell. The bond's Pulse perk and unique effect appeared.
- An invalid code reported an error and preserved the selected weapon.
- Selected a modern repeater: chamber, grip and mod controls appeared; obsolete barrel/prism controls did not. Selected Marksman Chamber and verified its effect in the summary.
- Used the new-gear filter and found Sahvyt's Cutlass.
- Browsed 5,805 modern catalogue entries, filtered 135 IDs absent from the older catalogue, searched PR_DISCIPLINE and selected it into the build.
- Switched to light mode, reloaded, verified that light mode persisted, then returned to dark mode.
- Rendered a 1.14.7 PNG card with omnicell and bond labels, downloaded it successfully and visually inspected the resulting 1200×675 image. Download uses a Blob URL for browser compatibility.
- The generated classic code was accepted by the separate Inventory editor's build planner with six equipment pieces, seven cell slots and no reported compatibility issues. This was a read-only planning check, not a save write.

## Scope

This verifies the local website, its data handling and exchange formats. It does not certify every combat statistic against a live 1.14.7 client. The modern metadata comes from the pinned pre-1.14.7 Reforged archive labelled balance 1.14.6; see README.md. The website remains a read-only planner. Dauntless Inventory 0.6.0 now imports its modern codes/files into game saves. The final cross-application flow and native sword/repeater checks in blank slots 5 and 6 passed, including restart and slot switching; see the combined release Verification directory. All 36 original save files still match their backup hashes.
