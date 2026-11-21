# ToneMaster V2 source handoff

This is the current implementation, not a fully device-tested release. Credits ran out before browser end-to-end and Android testing. Continuing that work requires available credits.

## Included
- The supplied ToneMaster Main App, extended rather than replaced: `/` displays it, and `/tonemaster/index.html` is the standalone app.
- Separate HTML Admin Panel: `/mgs-admin/index.html`. There are no administrator links in the Main App. The existing offline Owner licence backup tools remain distinct from administrator roles.
- Connected TONES, BEATS and APP controls; dedicated transpose buttons, semitone readout and zero reset.
- Beat Player, installed packs, beat store, sequencer, recording, saved projects and actual LAME MP3 encoding.
- The existing local encryption, device IDs, public licence verification key, instrument engine and settings remain in use. No original signing key was supplied or generated. Existing licence validity still depends on the preserved public key.
- Admin-only server pack validation and private storage. New replacement uploads are hidden until validation and explicit publication. Invalid WAVs, unsafe paths and oversized entries block pack approval.
- Android source for private download, SHA-256 checks, package/version/SDK checks, cryptographic APK verification against the installed signing certificate, installation permission and user-confirmed official Android installation.

## Website deployment
1. In this Lovable project, publish when ready. The project is not published by this handoff.
2. Open `/` for the Main App, and separately open `/mgs-admin/index.html` for the panel.
3. The designated administrator is `manqobagininda982@gmail.com`. Create that account in the separate Admin Panel, confirm the email and sign in. No account existed when checked during this handoff. Other signups are not administrators. The server can override its configured allowlist through `ADMIN_EMAILS`.
4. Upload a small ZIP first. Beat packs should have style folders containing numbered WAVs 1–15; missing numbers stay unavailable. Enter the original BPM. Review the validation report, then Publish.
5. Open the Main App's store and verify installation, playback and offline reopening before distributing to customers.
6. Native builds use `CONFIG.API_ORIGIN` in `public/tonemaster/js/config.js`; its current value is this project's stable published address. If hosting changes, update it and the native download-host allowlist, then rebuild the classic script.

## Running the source locally
- Install dependencies with `bun install` and use `bun run dev`.
- Public browser backend configuration must be supplied by the hosting environment. The archive intentionally excludes `.env`, credentials, private keys and repository metadata. The Main App's public catalogue calls go through the website; do not move private server keys into it.
- Keep this project's generated Cloud integration and migrations when deploying here. An independent deployment requires its own Cloud integration, managed environment settings and private `incoming` and `packs` storage buckets. The SQL migrations are included as schema source, not as a data export.
- After editing Main App modules: `node tonemaster-tools/build-bundle.js`.
- Regression checks: `bunx vitest run src/test/tonemaster-security.test.ts src/test/tonemaster-audio.test.js src/test/app-routing.test.tsx`.

## Android source integration
The native directory is source/snippets for Android Studio, not a compiled APK or complete Gradle project.
1. Create or use the existing Android project with package `com.mgsounds.tonemaster`, minimum SDK 24.
2. Copy the Kotlin files and XML resources, merge the manifest and add dependencies listed in `native-android/build.gradle.snippet` from Google's repository.
3. Copy the contents of `public/tonemaster/` into `app/src/main/assets/www/`. Do not include the Admin Panel, owner signing tools, keys or backend source in the APK assets.
4. Set version code 2 and version name 2.0.0 for this build. Updates must have increasing actual version codes, matching the release entered in the panel.
5. Sign with the same existing production Android signing certificate. Exact signer matching is intentional: rotated or unrelated signers and downgrades are rejected. Never send private signing keys in chat.
6. Compile and test on an Android device. APK upload validation checks structure/signature presence, not cryptographic authenticity; the native verifier and Android installer check authenticity before installation.
7. Verify unknown-source permission denied/granted, cancelled installation, wrong signer/package, altered SHA-256, SDK incompatibility, downgrade and successful update. These device checks have NOT been performed here.

## Verified during this continuation
- Latest preview compilation reported `build OK`.
- 18 automated tests passed: routing, designated confirmed administrator allowlist, unconfirmed/unrelated account rejection, WAV validation, unsafe ZIP paths, oversized decompressed content, loop detection, tone folder preservation, unsigned APK rejection, transpose/reset, separate Strings/Fretless recorded events, independent MIDI sources, mute/solo and quantization.
- The new upload-validation guards were read back from the database after application.

## Not verified / remaining
- No browser flow was exercised end-to-end in this continuation. Automated audio-model tests are not proof of audible output, sync, actual USB MIDI, offline reload, project reopening or MP3 export from the UI.
- No authenticated upload/preview/publish/install flow was tested: the designated account still needs creation and email confirmation.
- The native source has not been compiled or device-tested. A signed APK and Android device are required.
- The original ZIP contains no database export. Existing database records have not been imported.
- Firebase is not configured. Beat files currently use secured private Lovable Cloud storage; switching to Firebase requires secure credentials and further implementation.
- Background Web Audio playback depends on Android/browser power management; no uninterrupted-background guarantee is made.
- Device projects, recordings and installed packs are local, not cloud-synchronized.

The older supplied source documentation in `tonemaster-tools/README.md` describes V1; this document supersedes its V1-only deployment claims. Do not regenerate the licence-signing key merely to deploy V2, because that would invalidate previously issued licences.