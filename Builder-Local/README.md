# Dauntless Forever Builder · Local

A local, offline build planner for **Dauntless 1.6.2 and 1.14.7**, preserving the typography, colours, gear rack, perk ledger, dark/light themes and build-card style of the Forever Builder.

## Start

Extract the entire archive and double-click **Start-Builder.cmd** on Windows. The bundled Node runtime starts a read-only server at `http://127.0.0.1:49316` and opens the browser. Keep its console window open; close the window to stop it. No installation, account or Internet connection is required. Do not open `public/index.html` directly.

The port can be changed with the `BUILDER_PORT` environment variable. Browser storage is tied to the local address/port and browser profile. Export builds before changing either or clearing browser data.

## Use

- **Game version** selects separate item data and the remembered build for that version.
- Pick weapons, armour, lanterns, mods and specials. Select cells compatible with each socket. Base/Max levels update the displayed gear stats and perk tiers.
- **1.14.7** includes the Reforged cell categories, six omnicells, integrated repeaters with chamber/grip/mod choices, and legendary weapon bonds. The picker can show only gear absent from the original 1.6.2 planner.
- **Copy code / Load** exports or imports build codes, or a link containing a code after `#`. Loading a code switches to its game version. Invalid item identifiers, cell placement, ranks and parts are rejected before replacing the build.
- **Save build / Saved builds** keeps up to 50 named builds in this browser. **Export build / Import build** transfers JSON files between browsers or PCs. Clearing browser storage also removes the local library; exported files are independent copies.
- **Make card** creates a shareable PNG. Copy code or export the build file for the full importable data.
- **Item catalogue** provides search, categories and pagination over every entry of the two supplied catalogues, including cosmetics, currencies, materials and technical entries. Equipment with matching planner metadata can be selected from the catalogue. Non-equipment items are browsable, not gear slots. “New identifiers” compares catalogue IDs; it is not a claim that every unmatched ID is a newly released item.

## Code compatibility and game saves

Original **`162.`** codes preserve the online Builder's array indexes and remain compatible with that Builder and the existing Inventory editor's supported 1.6.2 imports.

New **`1147.`** codes have their own versioned format with stable item keys, omnicell and bond fields. They are supported by this local Builder and **Dauntless Inventory 0.6.0 or newer**. In the editor choose 1.14.7, connect the character, paste the code or open the exported build file, then explicitly choose a destination slot and confirm the backup/import. They are not codes for the public 1.6.2-only site.

This website **does not write to game saves**, grant inventory or patch server limits. Its server serves static files only. Dauntless Inventory remains the separate application that backs up and writes the selected character slot. No personal saves, account keys, game archives or local preferences are included.

## Included data and limits

| Dataset                | 1.6.2 | 1.14.7 |
| ---------------------- | ----: | -----: |
| Planner weapons        |   156 |    231 |
| Planner armour pieces  |   103 |    139 |
| Cells                  |    61 |     81 |
| Weapon parts           |    80 |     58 |
| Lanterns               |     8 |      8 |
| Omnicells              |     0 |      6 |
| Full catalogue entries | 5,407 |  5,805 |

The 1.6.2 planner data and code order come from the Forever Builder's legacy snapshot. The 1.14.7 planner uses the Reforged data snapshot **d3ec4a1a26c4d189792e7bd2e824df4cb080756b**, dated 28 March 2024, the last data commit before the installed 1.14.7 client build dated 1 April 2024. Its upstream `misc.yml` labels balance data **1.14.6**. This provenance is retained explicitly: it is not a fresh extraction or native certification of every 1.14.7 stat. The separately supplied Forever catalogue targets **1.14.7 CL647472**. Some catalogue entries are legacy, internal or prototypes; a catalogue ID alone does not prove that an item is usable in-game.

Modern metadata includes 76 weapon names, 36 armour names, 25 cell names and six omnicells absent from the legacy planner. Some original entries were removed or replaced, so these differences are not the net dataset-size increase. Missing/uncertain catalogue-to-planner matches remain browse-only rather than receiving invented effects. Damage output, encounter simulation, character XP and multiplayer are outside this planner's scope. Base/Max values describe the source gear data, not character power or a command to upgrade game inventory.

All planner icons, fonts and card sprites are included locally. External links in the credits open only when selected.

## Source layout and development

- `public/app.js`: gear pickers, statistics/perks, version switching, library and build-card renderer.
- `public/build-code.mjs`: shared, testable versioned encoders, decoders and compatibility validation.
- `public/catalogue.mjs`: complete item search, filtering and pagination.
- `public/style.css`: credited original visual style; `public/local.css`: local/version/catalogue additions.
- `public/data`: generated, version-specific browser data and asset maps.
- `sources`: pinned source data, original mappings and Reforged YAML inputs.
- `scripts/build-data.cjs`: reproducible data normalisation, interpolation and provenance report.
- `server.cjs`: static loopback server with no save-writing API.
- `tests/builder.test.mjs`: code compatibility, all modern gear roundtrips, metadata separation, assets and server boundaries.

To run the tests using the included runtime:

```text
runtime\node.exe --test tests/*.test.mjs
```

To regenerate data or format application code, install Node.js 24 and pnpm, then:

```text
pnpm install --frozen-lockfile
pnpm run build:data
pnpm test
pnpm run format
```

The generated browser datasets are included, so normal use does not require development dependencies. The data-build script preserves original 162 ordering and keeps modern categories/statistics separate. Raw YAML and a pinned upstream commit are included for review.

## Credits and licence

**GNU AGPL-3.0-only**. The complete application source and full licence accompany this distribution. See `LICENSE` and `NOTICE.txt`.

- **[Dauntless Forever](https://github.com/addison2k/DauntlessForever)** — catalogue data and preservation project. Credit to Addison2k and contributors.
- **[Dauntless Forever Builder](https://builder.dauntlessforever.com/)** — original visual design, legacy data/code format, renderer, preview icons, helmet and voxel card resources. Credit to A2K (Addison2k). The local version modifies and separates the original renderer to add versioned datasets, modern equipment, library/file exchange and full catalogue browsing.
- **[Dauntless Builder legacy](https://github.com/atomicptr/dauntless-builder-legacy)** and **[Dauntless Builder Reforged](https://github.com/atomicptr/dauntless-builder-reforged)** — equipment, cells, perk descriptions/effects and icon resources. Credit to atomicptr and contributors; Reforged inputs are pinned to the commit above.
- Saira Condensed and JetBrains Mono fonts: SIL Open Font License notices in `public/assets/fonts`.
- Bundled Node.js: licence and third-party notices in `runtime/LICENSE-node.txt`.

Game artwork and Dauntless belong to their respective rights holders. This is an unofficial local adaptation; it does not modify or publish the public Forever site.

## Native version filter

The published catalogue excludes IDs absent from the selected native client. Legacy omnicells and 1,699 other later-client entries are hidden and unavailable in pickers. Legacy code array indexes remain unchanged. Native validation and storage corrections are retained in sources/catalog-validation.json and applied by scripts/build-data.cjs.

Inventory export compatibility (1.0.1): import files or codes generated by Inventory 0.11.2. Version selection is automatic. Existing six-record 1.6.2 codes are unchanged; an optional seventh record preserves a legacy legendary weapon bond and displays its perks/effects in the planner. Use this updated local Builder for those extended codes. The public Builder has not been modified.

Catalogue visibility (1.0.2): hide unsupported entries and empty categories, internal test/debug objects and unequipped placeholders. The 1.6.2 and 1.14.7 player catalogues follow the Inventory editor flags. Existing build codes and saved builds are unchanged.
