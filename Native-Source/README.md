# Optional native extensions

Compatibility fix 2026-10-21: native147/d1147-live.cpp is based on Forever's
Loader1147-FpsFix-source at commit 96d878736eaa37927a767a81fe09332bcb52bf0d.
It preserves upstream changes and integrates Live into the existing client tick,
so enabling the boss health bar does not create a second hook for that function.
The 1.6.2 distributed binary is retained from the previous verified release.

AGPL-3.0-only; upstream credits are in ../NOTICE.txt. MinHook retains its BSD licence under native147/minhook/LICENSE.txt.

- native147/d1147-live.cpp: Forever 1.14.7 loader, including its original startup and equipment fixes.
- native147/live_refresh.h: game-thread inventory refresh and in-place loadout update for client and server.
- native162.cpp: 1.6.2 extension that loads the original Forever server as UndauntedInternalServer.base.dll and chains its existing tick hook.
- live_protocol.h: process-scoped commands and native application status shared by both extensions.

The updater verifies the known EXE and original native module hashes before installation. Runtime dispatch checks reflection signatures and single-player state. Live queries update an existing slot UObject: normal whole-array initialization invalidates references held by the open UI. Reapplying the active slot uses the existing native forced-activation function; inactive slots remain inactive. Old-process commands are ignored. Every build acknowledgement includes its operation, slot and process ID.

Build on Windows x64 with Zig 0.17.0 (the tested compiler):

    ./BUILD.ps1 -Compiler C:/Tools/zig/zig.exe

Copy the resulting DLLs from artifacts/ to ../Source-Code/native/ and regenerate the matching manifest SHA256 if rebuilding. Rebuild the portable app using Source-Code/README.md. The installer manages original module backups and launcher metadata; do not manually overwrite game files with these binaries.

The original 1.6.2 server is supplied by the user's existing Forever installation, not by this archive. Native source was formatted and rebuilt before the final in-game tests; the packaged native modules are those tested compiled binaries.

0.11.3 updates status publication and reads in both native targets. Heartbeats and build acknowledgements are published as complete files, with bounded Windows replacement retries. File time checks sample the precise clock after reading metadata. Game offsets, inventory/loadout reflection and original-loader checks remain unchanged.

Concurrent status regression: compile tests/status-publisher.cpp with Zig c++ -target x86_64-windows-gnu -municode -O2, then run tests/status-publication.cjs using the bundled Node runtime and pass the resulting .exe path. The test uses a disposable temporary folder and verifies complete JSON reads during 1,000 native publications.
