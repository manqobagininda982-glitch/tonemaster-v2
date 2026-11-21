# ToneMaster by MG:SOUNDS

Professional sampled-keyboard app: import your WAV tone ZIPs **once**, keep them encrypted on the phone, plug in a USB MIDI keyboard, pick an instrument and play.
Licence: **R250 per device**, offline-verified (Ed25519), no cloud, no database.

> **Read this first – three honest facts**
> 1. **No sample files are included.** You import your own ZIPs inside the app. Nothing here was tested with your real tones.
> 2. **Most "website → app" converters wrap a plain WebView, and Android WebView normally has no USB MIDI.** ToneMaster detects this and says so on screen (it never fakes MIDI or silently swaps in a keyboard). Choose a route in §2.
> 3. **No protection is unbreakable.** Someone who controls their phone can still record the audio output. This project makes casual copying hard; see `docs/SECURITY.md`.

## 1. What is in this project

```
index.html                  app page (loads one script: js/tonemaster.bundle.js)
manifest.webmanifest, sw.js PWA config (landscape, fullscreen, offline shell)
css/app.css                 dark charcoal + green UI, landscape-first
icons/                      192, 512, maskable-512 PNG icons
js/*.js                     readable source modules (util, zip, wav, detect, storage, library, samples,
                            engine, midi, licence, ed25519, backup, settings, config, app)
js/tonemaster.bundle.js     ALL modules bundled into one classic script (works from file:// and asset loaders)
tools/                      OWNER tools (Node 18+): generate-keys.js, issue-licence.js, build-bundle.js
android-native/             Kotlin source for the optional native shell (Keystore storage, USB MIDI, landscape lock)
docs/                       SECURITY.md
```
Upload/convert the **whole folder contents** (everything except `tools/`, `docs/`, `android-native/` is what the app needs; leaving them in is harmless).
`js/config.js` holds only the **public** licence key. Never put a private key in this folder.

## 2. Turning it into an Android app – pick a route

| Route | USB MIDI | Storage protection | Effort |
|---|---|---|---|
| **A. PWA → Trusted Web Activity** (PWABuilder.com / Bubblewrap) | **Yes** – runs in Chrome, which supports Web MIDI over USB-OTG | Browser mode (encrypted IndexedDB, see §7) | Low. Needs the folder hosted on **HTTPS** (GitHub Pages, Netlify, any static host). Manifest already requests landscape. |
| **B. Native shell** (`android-native/`) | **Yes** – native `android.media.midi`, no Chrome needed | **Best** – Android Keystore key + app-private files, backups disabled | Medium. Android Studio. |
| **C. Generic converter** (zip upload, WebView wrapper) | **Usually no** – app will show "MIDI unavailable in this app shell" | Browser mode | Lowest. Also check the converter supports file pickers (needed to choose ZIPs) and keeps site data. |

**Route A steps:** host the folder on HTTPS → open https://www.pwabuilder.com → enter the URL → *Package for stores → Android* → install the APK. Landscape and fullscreen come from `manifest.webmanifest`. Test MIDI: Settings → **Connect / allow MIDI**.

**Route B steps:** in Android Studio create *Empty Views Activity* (package `com.mgsounds.tonemaster`, minSdk 24) → copy `android-native/app/src/main/java/...` and `res/xml/no_backup_rules.xml` → merge `AndroidManifest.xml` → add dependencies from `build.gradle.snippet` → copy this website folder into `app/src/main/assets/www/` → build. The shell locks landscape (`sensorLandscape`), keeps the screen on, serves the site from assets, disables backups (so the library cannot be copied via cloud/device transfer), and exposes only its own bridge to the page. **This Kotlin source was written but not compiled or run in this environment – it needs your first build and device test.**

Orientation: the app always runs sideways. The manifest/native shell lock landscape, and if a phone is held upright the app turns itself sideways anyway.

## 3. Your keys and selling licences (do this before you sell)

The public key currently in `js/config.js` was generated during development. **Create your own pair** so only you hold the private key:

```
node tools/generate-keys.js --force      # writes owner-keys/private.pem (SECRET, back up offline) and rebuilds the bundle
```
Then re-publish/re-package the app. Keep `owner-keys/` out of anything you upload. Also edit `CONTACT` in `js/config.js` (your email/WhatsApp) so "Request licence" can reach you.

**Selling flow (no fake payments exist in the app):**
1. Customer installs ToneMaster → Activation screen shows their **Device ID** (`TM-XXXX-XXXX-XXXX-XXXX`) and the price.
2. They pay you (EFT, SnapScan, etc. – outside the app) and send the Device ID (the *Request licence* button prepares the message).
3. You run: `node tools/issue-licence.js --device TM-XXXX-XXXX-XXXX-XXXX --customer "Name"` and send them the printed code (`TM1.…`).
4. They paste it (or load it from a text file). It is verified offline against your public key and tied to that device.
5. **New phone / reinstall:** the Device ID changes. Verify purchase, then issue a new licence: add `--replaces OLD_LID`. Licences issued are logged in `owner-keys/issued-licences.log`.
6. **Your own owner licence:** add `--role owner`. It unlocks the **Owner** tab (encrypted backup/restore).

**Batch keys (no database, hand out after each sale):** `node tools/issue-batch.js --count 500 --prefix B1` creates `owner-keys/batches/B1-keys.csv` (a sales ledger: fill in `sold_to` and `date_sold`) and `B1-keys.txt`. Give one key (`TM2.…`) to each buyer. They paste it and it works; it binds to the first phone that activates it. Customer keys never show the **Owner/admin tab** – customers only get Play, Library (import tones), and Settings. Use a new `--prefix` for every batch. Honest limit: with no server, the same key pasted on a *second* phone also works, so sell each key once, keep the ledger, and list any leaked ID in `REVOKED_LICENCE_IDS` (`js/config.js`) in your next update. If you regenerate your signing keys, previously made keys stop working – regenerate the batch.

Limits of offline licensing: a licence can't be revoked remotely (you can list its ID in `REVOKED_LICENCE_IDS` for the next app update); a replaced device's old licence still works until its app data is cleared; the Device ID is per install, not per hardware, in browser mode (native mode stores it under a Keystore key). A temporary verification error never locks out a customer who was valid before (status "re-checking").

## 4. Getting tones (downloaded, named by the pack)

The app ships with **no tones and no tone names** – the Library is empty until tones are downloaded.
1. Upload a tone pack (ZIP with WAV files) on the **admin page** and give it a name and version.
2. In the app: **Library → ⬇ Download tones** → tap *Download*. The tone appears with the name you gave it.
3. Upload a *New version* on the admin page → phones show **Update** next time they open *Download tones*.

The app uses internet **only** inside the *Download tones* window. Everything else (playing, MIDI, settings, licence) works offline.
Files inside a pack: `1.wav`, `2.wav` … or `… Marker #N.wav` = Nth semitone from the root note (default C2, editable per instrument). WAV: 8/16/24/32-bit PCM or float, mono/stereo, 8–192 kHz.
*Import ZIP from phone* still exists for local ZIPs (named after the ZIP/folder).

## 5. Owner backup, recovery, new phone

* **Owner tab → Create encrypted backup**: one `.tmbackup` file, AES-256-GCM per record, key from your password (PBKDF2-SHA256, 400k iterations), integrity-checked. **Lose the password = lose the backup.** Copy it off the phone (share sheet / Documents folder in native shell).
* **Check integrity** verifies password + every sample hash. **Restore** verifies first, asks before replacing existing instruments, and changes nothing if the backup is damaged.
* **New phone / reinstall:** install → activate an owner licence for the new Device ID → Owner → Restore. Or just re-import your original ZIPs.
* Customers get no sample export and no owner tab. Customers can save/load a **settings** file only.
* **Corruption:** metadata and settings are checksummed with a previous-version copy; on damage the app falls back automatically, and rebuilds the instrument index from the stored samples if needed (Settings → *Rebuild index*). *Verify library* finds damaged samples.

## 6. Using the app

Play tab: Single / Dual / Split / Main+Dual / Main+Split; up to 3 layers, each with instrument, volume, ON/OFF, octave, transpose; master, instrument, bass, treble, brightness, global transpose/octave, release, split point, sustain pedal switch, all-notes-off. Everything is saved automatically. Settings → MIDI chooses device and channel (omni or 1–16).

## 7. Storage & copy protection (summary – full detail in docs/SECURITY.md)

* WAVs are never shown, linked or exportable; stored only as AES-256-GCM ciphertext bound to the sample ID; decrypted only to decode, then dropped.
* **Native shell:** key in Android Keystore (hardware-backed where available), files in private app storage, backups disabled.
* **Browser/TWA/generic mode:** non-extractable WebCrypto key + IndexedDB inside the app's private browser storage. Weaker than native; documented, not hidden.
* Library is tied to the device key; licences are tied to the Device ID; nothing is uploaded or shared.

## 8. Developer notes

* Edit `js/*.js`, then `node tools/build-bundle.js`.
* Audio latency: this is Web Audio (`latencyHint: interactive`); expect device-dependent latency (often 40–100 ms on phones). A native Oboe engine would be lower; it is not included.
