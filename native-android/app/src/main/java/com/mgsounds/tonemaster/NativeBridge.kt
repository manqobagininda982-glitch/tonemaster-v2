package com.mgsounds.tonemaster

import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.io.File

/** Methods called by js/storage.js (NativeStorage), js/midi.js and js/app.js (saveFile). Only exposed to our own https://appassets origin. */
class NativeBridge(private val a: MainActivity, private val web: WebView, private val store: SecureStore, private val midi: MidiBridge, private val updater: UpdateInstaller) {
    @JavascriptInterface fun appInfo(): String = updater.appInfo()
    @JavascriptInterface fun installUpdate(url: String, sha256: String, versionCode: Long) { updater.download(url, sha256, versionCode) }
    @JavascriptInterface fun isNativeStorage() = true
    @JavascriptInterface fun deviceId(): String = store.deviceId()
    @JavascriptInterface fun putSample(id: String, infoJson: String, b64: String): String = try { store.putSample(id, infoJson, Base64.decode(b64, Base64.NO_WRAP)); "ok" } catch (e: Exception) { "error:" + e.message }
    @JavascriptInterface fun getSample(id: String): String = store.getSample(id)?.let { Base64.encodeToString(it, Base64.NO_WRAP) } ?: ""
    @JavascriptInterface fun hasSample(id: String) = store.hasSample(id).toString()
    @JavascriptInterface fun deleteSample(id: String) = store.deleteSample(id)
    @JavascriptInterface fun listSamples(): String = store.listSamples()
    @JavascriptInterface fun wipeSamples() = store.wipeSamples()
    @JavascriptInterface fun storageInfo(): String = store.storageInfo()
    @JavascriptInterface fun putMeta(k: String, v: String) = store.putMeta(k, v)
    @JavascriptInterface fun getMeta(k: String): String = store.getMeta(k)
    @JavascriptInterface fun deleteMeta(k: String) = store.deleteMeta(k)
    @JavascriptInterface fun hasMidi() = midi.available()
    @JavascriptInterface fun startMidi() { a.runOnUiThread { midi.start() } }
    /** Owner backups / settings files: written to the app's external "Documents" folder so the owner can copy them off the phone. */
    @JavascriptInterface fun saveFile(name: String, b64: String) {
        val dir = a.getExternalFilesDir("Documents") ?: a.filesDir; File(dir, name.replace(Regex("[^A-Za-z0-9._-]"), "_")).writeBytes(Base64.decode(b64, Base64.NO_WRAP))
        a.runOnUiThread { android.widget.Toast.makeText(a, "Saved to " + dir.path, android.widget.Toast.LENGTH_LONG).show() }
    }
}
