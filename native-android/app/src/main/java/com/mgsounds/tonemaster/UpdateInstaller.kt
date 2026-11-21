package com.mgsounds.tonemaster

import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.WebView
import androidx.core.content.FileProvider
import com.android.apksig.ApkVerifier
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.security.MessageDigest
import javax.net.ssl.HttpsURLConnection

/** Downloads only to private cache. Android's official installer still requires user confirmation. */
class UpdateInstaller(private val activity: MainActivity, private val web: WebView) {
    @Volatile private var busy = false
    private var pending: File? = null
    private var waitingForPermission = false
    private val maxBytes = 100L * 1024 * 1024
    // Only this project's private signed-storage download host is trusted.
    private val downloadHost = "c--0588c18c-4a14-42f9-9818-74aced8450b3-prod.lovable.cloud"

    fun appInfo(): String {
        val p = activity.packageManager.getPackageInfo(activity.packageName, 0)
        val code = if (Build.VERSION.SDK_INT >= 28) p.longVersionCode else p.versionCode.toLong()
        return JSONObject().put("versionName", p.versionName).put("versionCode", code).put("sdk", Build.VERSION.SDK_INT).toString()
    }

    private fun notify(message: String, progress: Int = 0) {
        val event = JSONObject().put("message", message).put("progress", progress).toString()
        activity.runOnUiThread { web.evaluateJavascript("window.onToneMasterUpdate && window.onToneMasterUpdate($event)", null) }
    }

    @Synchronized fun download(url: String, hash: String, expectedCode: Long) {
        if (busy) { notify("An update is already in progress"); return }
        if (!hash.matches(Regex("[a-fA-F0-9]{64}"))) { notify("Invalid update fingerprint"); return }
        busy = true
        Thread {
            val file = File(activity.cacheDir, "updates/ToneMaster.apk").apply { parentFile?.mkdirs() }
            try {
                val u = URL(url)
                require(u.protocol == "https" && u.host == downloadHost && u.port in listOf(-1, 443) && u.userInfo == null) { "Untrusted update address" }
                val connection = u.openConnection() as HttpsURLConnection
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 30000; connection.readTimeout = 30000
                try {
                    require(connection.responseCode == 200) { "Update download was refused" }
                    val total = connection.contentLengthLong
                    require(total <= maxBytes) { "APK exceeds size limit" }
                    val digest = MessageDigest.getInstance("SHA-256")
                    var received = 0L; var lastProgress = -1
                    connection.inputStream.use { input -> file.outputStream().use { output ->
                        val buffer = ByteArray(65536)
                        while (true) {
                            val n = input.read(buffer); if (n < 0) break
                            received += n; require(received <= maxBytes) { "APK exceeds size limit" }
                            digest.update(buffer, 0, n); output.write(buffer, 0, n)
                            val progress = if (total > 0) ((received * 100) / total).toInt() else 0
                            if (progress != lastProgress) { lastProgress = progress; notify("Downloading update… $progress%", progress) }
                        }
                    } }
                    require(received > 0 && (total <= 0 || received == total)) { "Incomplete update" }
                    val actual = digest.digest().joinToString("") { "%02x".format(it) }
                    require(actual.equals(hash, ignoreCase = true)) { "APK failed SHA-256 integrity verification" }
                } finally { connection.disconnect() }
                verify(file, expectedCode)
                activity.runOnUiThread { pending = file; installOrRequestPermission() }
            } catch (e: Exception) { file.delete(); busy = false; notify("Update rejected: " + (e.message ?: "verification failed")) }
        }.start()
    }

    private fun verify(file: File, expectedCode: Long) {
        notify("Verifying package and signing certificate…", 100)
        val pm = activity.packageManager
        val archive = pm.getPackageArchiveInfo(file.path, 0) ?: error("Corrupt APK")
        require(archive.packageName == activity.packageName) { "Wrong package identity" }
        val current = pm.getPackageInfo(activity.packageName, 0)
        val code = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
        val currentCode = if (Build.VERSION.SDK_INT >= 28) current.longVersionCode else current.versionCode.toLong()
        require(code == expectedCode && code > currentCode) { "Version mismatch or downgrade blocked" }
        require((archive.applicationInfo?.minSdkVersion ?: Int.MAX_VALUE) <= Build.VERSION.SDK_INT) { "Requires a newer Android version" }
        val result = ApkVerifier.Builder(file).setMinCheckedPlatformVersion(Build.VERSION.SDK_INT).build().verify()
        require(result.isVerified && result.signerCertificates.isNotEmpty()) { "APK cryptographic signature is invalid" }
        val installed = if (Build.VERSION.SDK_INT >= 28) {
            pm.getPackageInfo(activity.packageName, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo?.apkContentsSigners?.toList() ?: emptyList()
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(activity.packageName, PackageManager.GET_SIGNATURES).signatures?.toList() ?: emptyList()
        }
        fun fingerprint(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val trusted = installed.map { fingerprint(it.toByteArray()) }.toSet()
        val supplied = result.signerCertificates.map { fingerprint(it.encoded) }.toSet()
        require(trusted.isNotEmpty() && trusted == supplied) { "Signing certificate is not trusted by the installed ToneMaster app" }
    }

    private fun installOrRequestPermission() {
        val file = pending ?: return
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            waitingForPermission = true
            notify("Allow updates from ToneMaster in Android settings, then return to confirm installation", 100)
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName)))
            return
        }
        try {
            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".updates", file)
            val intent = Intent(Intent.ACTION_INSTALL_PACKAGE).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION).putExtra(Intent.EXTRA_RETURN_RESULT, true)
            activity.launchPackageInstaller(intent)
            notify("Verified. Confirm the update in Android's installer", 100)
        } catch (e: Exception) { finish("Could not open Android's installer: " + e.message) }
    }

    fun resumePermission() {
        if (!waitingForPermission) return
        waitingForPermission = false
        if (Build.VERSION.SDK_INT < 26 || activity.packageManager.canRequestPackageInstalls()) installOrRequestPermission()
        else finish("Update cancelled: installation permission was not granted")
    }
    fun finish(message: String) { pending?.delete(); pending = null; busy = false; notify(message, 100) }
}