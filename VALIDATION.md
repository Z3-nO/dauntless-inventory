# Validation for 0.13.1

124 application tests and 11 Builder tests pass. The current 1.14.7 native loader
was rebuilt from the inspected upstream ChatCpu sources with the existing Live hooks.
A real game session passed ten inventory categories and eight build import/export
round trips, including all weapon families in preset six, with unchanged client and
server processes. The 1.6.2 native binary is unchanged; its earlier native-session
reports are retained explicitly as previous validation.

Automatic repair was tested on copies of the updated official Forever files, including
the full stability delay, complete launcher/backend/native repair, removal restoring
the new official bytes, and preservation of character data and authentication keys.
Unit checks cover unknown baselines, deleted bridges, rollback, concurrent updates,
required app versions, restart retry limits and draft preservation.

Additional compiled-EXE, public update and archive verification reports are included
in Test-results. These tests cover the included builds and do not guarantee future
Forever/game releases or every possible external mod combination.
