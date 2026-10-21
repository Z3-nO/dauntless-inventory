# Publishing signed Live module updates

The application's public verification key is in `update-channel.json`. Its matching
Ed25519 private key is stored separately by the maintainer and must never be committed,
uploaded, bundled with the EXE, or included in a release ZIP. Losing that key requires
shipping a new application with a new verification key. Protect and back up the key.

1. Adapt and test the native and bridge code for the supported game builds on copies.
   Preserve upstream fixes, notices, licences and corresponding native source.
2. Increase `Source-Code/package.json` version. Never republish an existing version
   with changed content. Update native manifest hashes after rebuilding DLLs.
3. Run application and Builder tests, installer round trips, failure/restore checks
   and the relevant native game tests. Check that personal data and secrets are absent.
4. Generate the release with Node 24 or later:

   ```text
   node Source-Code/scripts/publish-live-update.cjs --source Source-Code --out updates --key C:/Keys/live-updates-private.pem --source-url https://github.com/OWNER/REPOSITORY/tree/v0.12.1 --min-tool 0.12.0
   ```

5. Commit the complete corresponding source and `updates/releases/VERSION/` to the
   public project. Publish the matching source tag and release. Then publish the signed
   `updates/latest.json` feed. For module-only updates the EXE need not be replaced,
   provided the signed minimum application version and installer API remain compatible.

The publisher copies only the declared Live modules, data and rebuilt native payloads.
It signs exact manifest bytes using Ed25519. Each file has a signed length and SHA-256.
The client rejects unsigned manifests, unsupported paths, case-insensitive duplicates,
links, missing files, oversized content, protocol changes, redirects and downgrades.
HTTPS assets use the same origin as the feed. Loopback HTTP is supported for local tests.
No tokens, credentials or query strings belong in a public feed URL.

The update cache is outside the distribution in the app's preferences. A release is
verified before caching and again before loading its installer. New installs record
hashes of the installed bridge files. Automatic replacement requires those files,
the native DLLs and launcher/backend patches to remain intact. For pre-0.12.0 installs,
a one-time manual migration creates this verified installation manifest.

An update transaction backs up the existing bridge and known native/backend/launcher
targets, removes the previous installation, and installs the verified replacement.
Failure restores that snapshot. Character state, inventories and player keys are not
part of the replacement. Changing a Forever loader remains a compatibility change:
a tested signed module must explicitly support it. Unknown baselines stay blocked.

For development from Git, use an installed Node 24+ to run
`node --test Source-Code/tests/*.test.cjs`. The portable release bundles Node; the
repository excludes that runtime binary and the EXE. The full offline distribution,
including EXE, source and local Builder, is supplied in GitHub Releases.
