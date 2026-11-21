package com.mgsounds.tonemaster

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.view.View
import android.view.WindowManager
import android.webkit.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import java.io.File

/** Hosts www/ (copy of the ToneMaster website project) from assets via https://appassets.androidplatform.net/ – no network needed, no file:// access. */
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var updater: UpdateInstaller
    private val installer = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        updater.finish(if (result.resultCode == Activity.RESULT_OK) "Update installed" else "Installation cancelled or refused by Android")
    }
    fun launchPackageInstaller(intent: Intent) { installer.launch(intent) }
    private var chooserCb: ValueCallback<Array<Uri>>? = null
    private val pick = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        chooserCb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(r.resultCode, r.data)); chooserCb = null }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(s: Bundle?) {
        super.onCreate(s)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
        val loader = WebViewAssetLoader.Builder().addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this)).setDomain("appassets.androidplatform.net").build()
        web = WebView(this); setContentView(web)
        WebView.setWebContentsDebuggingEnabled(false)                               // release: no remote inspection of the library
        web.settings.apply { javaScriptEnabled = true; domStorageEnabled = true; allowFileAccess = false; allowContentAccess = false; mediaPlaybackRequiresUserGesture = false; setSupportZoom(false) }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest) = loader.shouldInterceptRequest(r.url)
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest) = r.url.host != "appassets.androidplatform.net"   // never navigate away
        }
        web.webChromeClient = object : WebChromeClient() {                          // lets <input type=file> (ZIP import) work
            override fun onShowFileChooser(w: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean { chooserCb?.onReceiveValue(null); chooserCb = cb; pick.launch(p.createIntent()); return true }
        }
        updater = UpdateInstaller(this, web)
        web.addJavascriptInterface(NativeBridge(this, web, SecureStore(this), MidiBridge(this, web), updater), "ToneMasterNative")
        web.loadUrl("https://appassets.androidplatform.net/www/index.html")
    }
    override fun onPause() { super.onPause(); web.evaluateJavascript("document.dispatchEvent(new Event('visibilitychange'))", null) }
    override fun onResume() { super.onResume(); if (::updater.isInitialized) updater.resumePermission() }
}
