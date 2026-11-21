# ToneMaster – protection model and limits

## What is implemented
| Goal | Implementation |
|---|---|
| No raw WAV export | No UI, no download link, no `blob:`/file URL of any sample. Samples exist as plaintext only inside JS memory during import and decoding. |
| Encrypted at rest | AES-256-GCM, random 96-bit IV per sample, sample ID as associated data (ciphertext can't be swapped between samples). |
| Key protection | Native: Android Keystore AES key (StrongBox when available), non-exportable. Browser: non-extractable WebCrypto `CryptoKey` kept in IndexedDB. |
| Private storage | Native: `filesDir/ToneMaster/ProtectedSamples/<Bank>/…` (not Downloads, not visible to other apps); `allowBackup=false` + extraction rules block cloud/device-transfer copies. Browser: origin-private IndexedDB. |
| Memory hygiene | Decrypted bytes are dropped right after decoding; only decoded `AudioBuffer`s are cached, under a memory budget, and released when unused or when the app goes to the background. |
| Device-bound licence | Ed25519-signed payload contains the Device ID. Copying a licence file to another phone fails with a clear message. Only the public key ships. |
| Batch keys | Pre-made signed keys (`TM2.`), unique IDs, bind to the first phone that activates them; customer role only. Cannot stop a key being reused on another fresh install (no server). |
| No cloud | Nothing is uploaded; no analytics; no database. |
| Owner backup | Password-based (PBKDF2 400k → AES-GCM), integrity-checked, owner licence only. |

## What cannot be promised
* **Audio can always be recorded** (analog hole, screen/audio recorders, a modified device). Nothing here prevents that.
* **Browser mode is weaker.** The encryption key sits in the same browser storage as the ciphertext. A rooted phone, a debuggable build or a modified wrapper can read both. It stops casual copying and file browsing, not a determined attacker.
* **A rooted device or a patched app** can bypass licence checks (the checks are JavaScript). Obfuscation would only slow this down; it is not included.
* **Native shell:** the page receives decrypted bytes through a JavaScript bridge (needed to decode audio), so a patched APK could log them. Debugging of release builds is disabled; consider Play Integrity checks if piracy becomes serious.
* **Offline licences** cannot be revoked remotely and can be shared along with a device's whole phone image. The Device ID in browser mode is per installation.
* The app deliberately has **no spyware, remote wipe, hidden monitoring or destructive actions**; a failed check only disables playback, never deletes data.

## Operational advice
Generate your own signing keys (`tools/generate-keys.js --force`), keep `owner-keys/private.pem` offline, keep encrypted owner backups in two places, issue licences only after payment, and keep a log (`issued-licences.log` is written for you).
