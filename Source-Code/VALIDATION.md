# Live Preview 0.13.0 validation

Application update changes are tested separately from native game behavior.
The native DLLs, inventory formats, build import/export and character operations
are retained from 0.12.1. Application tests cover signed desktop manifests, exact
file sizes/hashes, release URLs and source tags, interrupted downloads, corrupt
cache recovery, release immutability, downgrade rejection, persisted settings,
activation only after startup, failed-update loop prevention, untrusted redirects,
cache links and editor quiescence before restart. The local HTTP test checks every
script referenced by the page, including desktop update controls.

The distribution's Test-results contains the executed automated tests, final EXE
checks, application restart/bootstrap checks and the published asset verification.
Original character files are checked independently; update tests use isolated
preferences and copies. Previous native checks on 1.6.2 and 1.14.7 are retained as
component evidence; this release does not claim new native compatibility.

Supported native builds remain 1.6.2 CL271281 and 1.14.7 CL647472 on inspected Forever
baselines with one local player. Unknown future loaders require tested compatible
modules. Legacy legendary-bond reimport remains unsupported; invalid modern sockets
are rejected. Pre-existing Forever inventory hash warnings are outside this change.
No finite test run guarantees every map, combat/cosmetic effect, PC or future update.
