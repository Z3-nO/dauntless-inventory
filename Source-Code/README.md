# Dauntless Inventory Live Preview 0.13.1

## Following Forever updates

Inventory detects changes to previously installed Live targets. After the files
remain stable for one minute and the game/server are closed, it validates the
complete replacement against signed known baselines and reinstalls the backend,
launcher patches and native modules together. Updated official files are kept as
the new originals; removal restores those files. Unknown changes and modified Live
bridge code remain blocked. Failed repair restores the exact pre-repair snapshot.
Known installations remain registered if Forever removes the bridge folder; an
intentional Remove Live clears that registration and is respected.

When a signed Live release requires a newer Inventory app, the default-enabled
**Download and restart Inventory automatically for required Live compatibility
updates** option downloads a sufficient signed app and restarts Inventory after
current writes finish. Pending item selection and Builder text are saved locally
and restored for review. An update that fails startup is not automatically retried
in a loop. This does not close the game, download a new game build, or manufacture
native compatibility for unpublished future loaders. Forever manages its own game
and launcher downloads; Inventory follows their installed changes with compatible
published Live releases.

## Automatic application updates

The portable EXE now checks for complete application releases as well as Live modules.
A signed release downloads automatically while Inventory is open. Choose **Restart and
update**, or leave **Apply downloaded updates the next time I open Inventory** enabled.
The original EXE then opens the latest verified managed version; it does not need to be
replaced or sent again. Existing directories, preferences and character files are kept.

Settings separates **Application updates** from **Live module updates**. Both automatic
download and activation on next launch can be disabled. A running save finishes before
the application restarts. The previous EXE remains available if startup fails, and a
failed update is not retried endlessly. Manifests use the existing Ed25519 trust key;
EXE files are checked by signed SHA-256 and length before download activation and again
before each managed launch. This is distinct from Windows Authenticode signing.

Users of 0.12.1 or older need to download 0.13.0 once, because their EXE does not include
an application updater. Later releases only need publication on the project feed.
Updating app code does not automatically make unknown future Forever loaders compatible.
Those still need a tested compatible Live module. The separate local Builder folder is
included in the full release ZIP; it is not replaced by the Inventory EXE updater.

## Live module updates and persistent game session

Settings now includes **Live module updates**. Signed project releases are checked
at startup and every 30 minutes while the app is running. Verified downloads are
installed automatically into an existing Live installation when the game and
Forever server are closed. No background service runs after Inventory closes.
Automatic checking and installation can be disabled independently. The built-in
public key verifies every release; each file is checked again before installation.
Downloads survive an app restart. Unsupported files, signature failures, redirects,
older releases and unrelated local modifications are rejected. Failed replacements
restore the previous native module and bridge from a transaction backup.

For a Live installation created before 0.12.0, click **Update installed Live module**
once with the game/server closed. This creates the verified bridge manifest used
for later automatic updates. If Live is not installed yet, use **Install Live connection**.
Signed update folders can also be imported offline. See [UPDATING.md](UPDATING.md)
for the release format and publishing instructions.

Inventory detects a single running local Live game and follows its active character,
using that game's full inventory requests as the character identity. The selection
is locked to that character while Live is active. Autosaves refresh the displayed
revision automatically. A temporary backend outage pauses writes and retries the
same session without discarding the selected profile. A changed review must be
reviewed again; writes are never silently retried. Ambiguous sessions and missing
native heartbeats keep writes paused. This does not enable multiplayer support.

The updater distributes compatible modules that have been published by the project.
It does not adapt native code to a future Forever release by itself, update Forever,
or replace this application's EXE. A module requiring newer updater capabilities
requests an application upgrade instead. Full source, AGPL-3.0 and upstream credits
remain available with releases.

Compatibility fix, 21 October 2026: Native Live accepts both inspected 1.14.7
Forever loader releases (BAA60615 and CFE9B7B3) for CL647472. The rebuilt loader
includes the current upstream FPS/crash guard, DXGI chain and optional mod support.
Live and the boss health bar share one client tick hook. Unknown loaders and
mixed game/package versions remain blocked; repair or update Forever rather
than restoring an older loader. The installer backs up the exact original
release and removal restores it.

A local Windows desktop editor for Dauntless Forever 1.6.2 and 1.14.7.
The executable opens its own application window. No browser window or Node installation is needed.


This is a separate optional preview based on offline 0.9.1. Keep the offline release in its own folder.

## Live setup

1. Close Dauntless and Forever, including every local server. Remove any previous Live preview with its own Settings controls before installing this version.
2. Run DauntlessInventoryLive.exe. In Settings, select the Forever version folder containing backend/ and data/. Native setup uses the GameDir configured in that version's config.json.
3. Click Install Live connection for the selected version. Every replaced backend, native module and launcher file is backed up before installation. The Dauntless EXE is verified and never written.
4. Start the selected version using its own 2 - PLAY.bat. Enter Ramsgate fully, then connect Inventory to that same version folder and select the character currently playing.
5. Apply supported items, quantities, maximum upgrades or a build to an existing slot. Both local server and local client request the updated inventory automatically. Build imports then populate the existing native slot; an active slot is reapplied to the character. Reopen Equipment if its screen was already open. Large inventories can take tens of seconds.
6. Refresh the connection status to see delivery and native build application separately. Wait for both processes to acknowledge a build before another edit. A failed or missing acknowledgement leaves the slot protected from stale client saves; close the game and server before recovery or removing the extension.

Native Live supports **1.6.2 CL271281** and **1.14.7 CL647472**, with the exact inspected Forever modules and one connected local player. Other builds and changed native baselines are refused. Multiplayer and LAN are outside its supported scope. Reset, restore and adding slots remain offline operations. Build mappings and item restrictions are unchanged from offline 0.9.1; absent or unsupported items are not enabled by Live.

For 1.14.7, the optional loader replaces the supported dxgi.dll and updates its launcher checks and client environment. For 1.6.2, a separate extension loads the original server from UndauntedInternalServer.base.dll; the original bytes are retained. Do not copy either module manually between game versions.

To remove Live, close the game and all Forever servers, open Settings and click Remove Live and restore originals. Removal checks all installed files first and refuses to overwrite another mod's changes. It restores original files and removes only additional files created by the installer. Inventory edits and save backups remain. Keep the stable offline release in its own folder; its compatible Builder does not need replacing. Do not run both Inventory applications against the same save simultaneously.

## Credits and licence

- **[Dauntless Forever](https://github.com/addison2k/DauntlessForever)** — catalogue data used by this editor. Credit to Addison2k and the Dauntless Forever contributors. The source inputs, upstream commit and catalogue transformations are recorded in `NOTICE.txt`.
- **[Dauntless Forever Builder](https://builder.dauntlessforever.com/)** — bundled preview icons, build-code format and ordered item identifiers. Credit to the Forever Builder creators and contributors.
- **[Undaunted](https://github.com/SyST3MDeV/Undaunted)** — public SDK reference used to cross-check native loadout field names.

The application is distributed under **GNU AGPL-3.0-only**. The full licence is in `LICENSE`, and the complete application source, tests and build instructions accompany the executable. Third-party components and game assets retain their respective rights and notices.

## Offline operations

The following original instructions apply with Live disconnected and the game/server closed.

1. Open `DauntlessInventory.exe`.
2. Select the game version.
3. Open **Settings** in the sidebar. Choose the version, its **Forever data folder**, and optionally the **Game installation folder** containing `Archon/Content/Paks`. Click **Save directories**. Configure each version separately. Blank fields use automatic detection.
4. Close Settings, click **Connect character**, then select your character. Changing directories requires a new connection.
5. Select catalogue items and quantities, or paste a build code/shared Builder URL.
6. For a build, click **Read build**, then explicitly select an existing loadout slot.
7. Review the exact character, version and slot. Confirm to create a backup and apply.

Close the game and its local server before writing. Closing this application also stops its editor service. With Live removed, these operations use the offline save format. Live setup above describes the optional backend and loader changes.

Version 0.9.1 fixes maximum upgrades when a legacy character owns multiple copies of the same item. Each owned instance is upgraded, while custom metadata and instance identifiers are retained. Repeating the same maximum upgrade leaves already-upgraded instances unchanged.

## Directory settings

Settings contains all directory fields, optional exported image linking and texture path information. Preferences persist outside the application in `%LOCALAPPDATA%/DauntlessMateriali/preferences/directories.json`. Game configuration files and saves are never changed when saving preferences. Use **Auto-find directories** to read the current PC's standard Forever/Offline installation and its configured game folder. Detection validates the selected version and existing Paks directory; it fills fields without saving. If nothing is found, select the directories manually. Blank save fields use version-specific automatic detection on connection. Public examples use `%LOCALAPPDATA%` instead of a username. The native Browse buttons open Windows directory pickers.

## Loadout slots

The editor reads all saved slots and the connected server's actual limits. In 1.6.2 it reads LOADOUT_SLOTS from backend/metagame/.env, or the installed metagame server's default. In 1.14.7 it reads server bounds, account slot metadata and saved Slayer Path unlocks. It never assumes that three saved records mean only three available slots.

Manage loadout slots shows saved, available and server limits. Explicitly choose an existing slot to copy and the number to add, then review and apply. A full save backup is created; the existing slots, inventory and active slot are preserved. New slots share existing equipment references. In 1.14.7 the account slot metadata is updated so the native backend retains the new slots; this may also unlock account slots for other characters. An unavailable server limit prevents creation but never truncates existing records.

Unsaved available slots are visible in the build selector and remain disabled until created. The editor respects the installed backend's writable index limit; it does not modify game server limits.

## Build import

Version **1.6.2** continues to accept the original `162.` codes with the same import behavior. Version **1.14.7** accepts the local Builder's `1147.` codes and exported `.dfbuild.json` files. Paste a code or choose **Choose build file**, read the preview, then choose the character and existing destination slot. The versions are never converted across one another.

The modern importer applies the selected Base/Max levels, cell ranks, lantern, omnicell, special, mod and legendary bond. Native catalogue identifiers were checked against the installed 1.14.7 CL647472 catalogues and English localization. Legendary bonds are stored in weapon-part metadata, not the unrelated subweapon field. Existing equipment instances are reused only if their level matches; otherwise a separate instance is created so other slots keep their original equipment levels. Repeat imports reuse matching instances and do not accumulate cells.

No slot is selected automatically. Other loadout records and the active-slot setting are preserved. A complete save backup is written to `backup/materiali-tool` inside the connected version folder. The maximum-upgrade checkbox works on both versions. For 1.14.7 it applies the native Base/Power Surge levels from the verified modern equipment mappings to every owned copy of each selected item, preserving instance identifiers and existing parts. Starter equipment with only a base level remains at that level. Slots using upgraded equipment reflect the upgrade; their loadout records are not rewritten. Unverified progression variants block the transaction before any save write. Uncheck the option to grant such items at their default level.

Modern mapping coverage: **229/231 weapons, 139/139 armour pieces, all 81 cells at all three ranks, 58/58 weapon parts, 8/8 lanterns and 6/6 omnicells**. Silver Sword and The Golden Claws remain blocked because their final progression variant has no verified mapping. An uncertain match blocks the complete import before writing. The legacy mapping coverage remains 150/156 weapons, 99/103 armour pieces, 8/8 lanterns, 79/80 parts and 59/61 cells.

The Builder's modern balance metadata comes from the pinned Reforged snapshot documented in the included local website. The importer validates storage identifiers against the installed client; this is not an exhaustive combat validation of every item.

## Catalogue and previews

Published IDs are checked against the installed native catalogues: 133 catalogues for 1.6.2 and 153 for 1.14.7. 1,705 IDs absent from the legacy client are excluded, including all omnicells. The native IsStackable flag corrects storage for 194 legacy cosmetic/accessory entries. Details are in data/catalog-validation.json. Presence in a client catalogue still includes internal/obsolete entries; it does not certify every item as playable.


- **1.6.2:** 5,407 native-present catalogue entries, 4,433 with a supported editable storage format.
- **1.14.7:** 5,805 published catalogue entries, 5,803 editable.
- Entries with unknown storage and special Middleman state tokens are view-only.
- Weapons, armour, lanterns, cells, cosmetics, weapon parts, materials, consumables, currencies and technical entries are grouped by the selected version.
- Some entries exist in the data but are prototypes, obsolete rewards or otherwise unavailable through normal gameplay.
- Unknown display names remain as their catalogue codes; display names may reflect the source catalogue rather than an old game's localization.

395 preview associations sourced from the public Builder are bundled. Lower-rank cells may have no bundled preview. Images can also be linked from a local folder or chosen manually per item. Live Preview preferences are isolated under `%APPDATA%\DauntlessInventory-LivePreview`; the offline app keeps its own existing settings.

Folder matching accepts PNG, JPEG and WebP. An optional `materiali-images.json` in the selected image folder maps item codes to relative image paths. Unreal `.pak` and `.uasset` files require texture export first; archive decoding and 3D models are not included.

### Standard texture paths

The included Builder previews resolve from assets/builder under the running tool folder (resources/tool/assets/builder in the unpacked desktop app). The UI displays this exact path and verifies every icon-map association. Custom imported images and exported images take priority, with a bundled fallback if a linked file disappears. Repeated T*/UI*/ICON\_ prefixes in exported filenames are accepted.

Original game textures are in <GameDir>/Archon/Content/Paks. GameDir is read from the selected Forever version's config.json (or launcher.json). For example, C:/Games/Dauntless_1.14.7/Archon/Content/Paks. They contain Unreal archives, not ready-to-display PNG files. The editor reports them separately from included previews and exported image folders; archive extraction is not implemented.

## Character reset and restore

Connect the character, open **Settings & directories**, then **Reset selected character**. Confirm the displayed character/version by typing the character name. The editor creates a complete save backup before replacing the selected character's inventory and every loadout with starter equipment, clearing character quest data and the legacy character's breadcrumbs/encountered-content rows. Name and AppearanceData stay unchanged. Existing slot count is retained.

Shared account progression (including Slayer's Path, weapon-skill tracks, mastery and account entitlements) and other characters are preserved. This is a character reset, not an account wipe. Account and launcher files outside the character save are not reset.

The **Before-reset backups** selector persists across restarts. Choose one and confirm **Restore selected backup** to restore only the selected character's previous data, inventory and loadouts. The current save is also backed up before restoration. Stale writes, a running backend, mismatched names and backups belonging to another character/version are rejected. Reset backups are retained in `backup/materiali-tool`; keep the `.bak`, matching `reset-point-*.json` and accompanying `.active.json` files together. The legacy active-slot file in data/loadouts is captured and restored for the selected character; changing it invalidates a pending request. If a database commit fails, both database and active-slot restoration are rolled back.

## Restore

With the game, Forever server and editor closed, keep a copy of the current save and restore a selected backup:

- 1.6.2: restore it as `data/undaunted.db`.
- 1.14.7: restore it as `data/state.json`.

For SQLite, do not replace a database while connections or uncheckpointed WAL/SHM files remain. Backups are retained without automatic deletion.

## Readable source layout

| File                    | Responsibility                                                |
| ----------------------- | ------------------------------------------------------------- |
| `main.cjs`              | Native desktop window, startup and shutdown                   |
| `preload.cjs`           | Restricted native folder-picker bridge                        |
| `server.cjs`            | Local authenticated API and static UI files                   |
| `saves.cjs`             | Version-specific save adapters, transactions and backups      |
| `inventory.cjs`         | Stack quantities, unique instances and equipment levels       |
| `build-import.cjs`      | Builder-code decoding, item matching and compatibility checks |
| `loadouts.cjs`          | Changes to the explicitly selected slot                       |
| `images.cjs`            | Bundled icons and local preview images                        |
| `public/app.js`         | Catalogue and inventory controls                              |
| `public/build-ui.js`    | Build preview, slot selection and review                      |
| `tests/editor.test.cjs` | Save and loadout-preservation tests                           |

Code is separated by responsibility and formatted for readability. Catalogue facts are JSON files under `data/`; no game credentials or personal saves are included.

### Settings and slot modules

- `settings.cjs`: validated per-version directories and atomic preference persistence.
- `slot-management.cjs`: installed server limits and slot creation.
- `public/settings-ui.js`: Settings dialog and native directory pickers.
- `public/slots-ui.js`: explicit source-slot selection and backup confirmation.
- `tests/settings.test.cjs`: directory isolation, validation and unchanged game files.
- `tests/slots-images.test.cjs`: slot creation, configured limits and preview fallback.

Code uses consistent formatting and separate modules; no minified application code is shipped.

## Build from source

Requires Windows x64 and a current Node.js installation for the development tools. The packaged app includes its own Node 24 runtime.

```text
npm ci
node node_modules/electron/install.js
npm start
npm run build
npm test
```

Electron 44.9.1 and electron-builder 26.15.3 are pinned in the lockfile. The portable executable is unsigned. Build output goes to `dist/`.

## Validation limits

Automated tests cover Builder-code parsing, maximum equipment levels, +3 cell selection, save transactions for both versions, explicit slot selection, unchanged other slots, backups, stale-save rejection and repeat-import behavior. UI and native-window checks are recorded in `VALIDATION.md`.

Native weapon-part field casing and subtype identifiers were corrected against existing local saves on 20 October 2026 (version 0.3.1). Real-save copy transactions pass for both versions. See VALIDATION.md for the exact gameplay checks and remaining limits. The save import feature is experimental for that reason.

Unofficial fan tool. See `NOTICE.txt` and `LICENSE` for credits and licensing.

UI update: the catalogue hides unsupported storage entries and empty categories. Build selection only lists saved, available presets. Presets belong to one character; copying one creates no duplicate items. Creation controls are hidden when disconnected, at the slot limit, or connected Live. Licence and upstream credits are preserved.

## Export a saved in-game preset

In **Your equipment presets**, choose an existing in-game slot and click **Create Builder code**. Copy the code or save a `.dfbuild.json` file, then paste/open it in the included **Builder-Local 1.0.2**. The Builder switches between 1.6.2 and 1.14.7 automatically. This selects the originating version; it does not convert version-exclusive equipment.

Export reads the last preset saved by the game. It resolves equipment by its exact inventory instance and includes Base/Power Surge levels, cell ranks, weapon parts and legendary bonds; modern presets also include their Omnicell. Cached metadata for other weapon types is ignored. Cosmetics, dyes, consumables, progression and account identifiers are outside the build-code format and are not exported. Invalid or unrepresentable saved equipment produces an error instead of an incomplete build. Export does not change a save, activate a preset or create a backup.

With the game and server closed, both save formats are read directly. While connected Live, the updated bridge reads the current server state. Remove the previous Live connection using its own release, then install this one with the game/server closed. Older bridges cannot export while running; the application reports that an update is required.

Ordinary 1.6.2 codes keep their original six-record format. A 1.6.2 legendary bond adds an optional seventh record, supported by the included local Builder. Such codes need the updated local Builder; the unchanged public Builder is not guaranteed to support this extension. Importing a legacy bond back into the game is outside the current importer and is explicitly refused. Existing six-record imports keep their established Power Surge/+3 behavior. Modern 1.14.7 codes retain their existing format and importer.

## Catalogue audit 0.11.3

The catalogue hides and refuses internal debug/test objects and unequipped placeholders. This removes 4 legacy and 25 modern technical entries from grant controls, leaving 4,429 editable 1.6.2 items and 5,778 editable 1.14.7 items. Existing saved instances are preserved. The local Builder applies the same player-item visibility rules, including version-specific categories.

Source formatting is checked with Prettier; the native source uses the included clang-format configuration. The native status exchange now publishes complete snapshots atomically, uses replacement-friendly readers and precise Windows timestamps. Both native targets were rebuilt from the included source. The test reports distinguish automated storage/transaction checks, real local client/server acknowledgements, UI checks and unsupported scope.

During the 1.14.7 comparison, the client logged inventory state hash mismatches even with the extension removed, the original Forever loader restored and no editor operations. This existing behavior of the local game/backend is recorded separately from successful native operation acknowledgements; the editor does not claim to repair it.

Live heartbeat correction: file timestamps and the JavaScript clock are compared at whole-millisecond precision, with the clock sampled after reading metadata. A changing or partially written native heartbeat is retried up to three times. Corrupt, missing, stale and genuinely future heartbeats still fail closed; previous connection states are never cached as valid. Regression tests reproduce both Windows timestamp precision and concurrent writer behavior.

The verified Recruit's Mask is retained at its native level 0 even though its native identifier contains UNEQUIPPED; catalogue filtering does not remove this legitimate starter item.

Version 0.12.1 also tolerates up to 32 ms of Windows file/JavaScript clock skew. Larger future timestamps, stale signals and corrupt snapshots remain blocked. The 0.12.0 signed module is retained unchanged; 0.12.1 has its own signed manifest.
