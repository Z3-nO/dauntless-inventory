# Live Preview 0.12.1 validation

21 October 2026. The native DLLs are retained from the verified 0.11.3 compatibility
fix; this release changes the update system, bridge session reporting and desktop UI.

97 application tests and 11 local Builder tests pass. Updater tests cover signed
manifests, wrong signers, corrupt files, unsupported paths, duplicate names, sizes,
redirects, interrupted downloads, cache revalidation, version compatibility,
downgrades, old-bridge migration, running processes and transactional restore.

An isolated integration test installs the previous Live module, migrates it to
0.12.0, imports a separately signed private test release and applies it automatically
to copies of both supported versions. Modified bridge files are refused. Removing
the extension restores the original native modules; character save bytes are unchanged.
The private future-version fixture is excluded from published updates and releases.

Session tests cover repeated game autosaves, active-character selection, ambiguous
sessions, missing heartbeats, a temporary backend outage, automatic recovery,
in-flight writes, invalidated reviews and late responses after a version change.
The same local character remains selected through repeated revision changes.

The distribution's Test-results records packaged-EXE, public-feed, installer and
native-session checks separately. These results validate the stated scope, not every
cosmetic/combat effect, multiplayer session, map transition or future Forever build.
Legacy legendary-bond reimport remains unsupported. Existing invalid modern sockets
are rejected. Pre-existing Forever inventory-hash warnings are not repaired here.

Native support remains 1.6.2 CL271281 and 1.14.7 CL647472 on the inspected Forever
baselines, with exactly one local player. New loader support must be implemented,
tested and published as a signed release. The updater does not invent compatibility
or silently weaken native checks. Application EXE updates remain separate.

Version 0.12.1 also tolerates up to 32 ms of Windows file/JavaScript clock skew. Larger future timestamps, stale signals and corrupt snapshots remain blocked. The 0.12.0 signed module is retained unchanged; 0.12.1 has its own signed manifest.
