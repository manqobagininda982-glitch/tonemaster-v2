package com.mgsounds.tonemaster

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom

/** Private app storage: filesDir/ToneMaster/{ProtectedSamples/<Bank>/, Metadata/, Settings/, Licences/, Backup/}. Not visible to other apps or in Downloads. */
class SecureStore(ctx: Context) {
    private val root = File(ctx.filesDir, "ToneMaster").apply { mkdirs() }
    private val samples = File(root, "ProtectedSamples").apply { mkdirs() }
    private val meta = File(root, "Metadata").apply { mkdirs() }
    private val folders = emptyMap<String, String>()   // no built-in tone names: tones are named by their downloaded pack
    private fun h(s: String) = MessageDigest.getInstance("SHA-256").digest(s.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun dirFor(inst: String) = File(samples, folders[inst] ?: "Other_Tones").apply { mkdirs() }
    private fun find(id: String): File? = samples.walkTopDown().firstOrNull { it.isFile && it.name == h(id) + ".tms" }

    fun deviceId(): String {
        val f = File(root, "Settings/device.id").apply { parentFile?.mkdirs() }
        if (!f.exists()) { val b = ByteArray(10).also { SecureRandom().nextBytes(it) }; f.writeBytes(KeystoreVault.encrypt(b, "device".toByteArray())) }
        val b = KeystoreVault.decrypt(f.readBytes(), "device".toByteArray()); val a = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
        val bits = b.joinToString("") { Integer.toBinaryString((it.toInt() and 255) + 256).substring(1) }
        return "TM-" + bits.chunked(5).filter { it.length == 5 }.map { a[it.toInt(2)] }.joinToString("").chunked(4).joinToString("-")
    }
    fun putSample(id: String, infoJson: String, plain: ByteArray) {
        val inst = runCatching { JSONObject(infoJson).optString("inst") }.getOrDefault("")
        val f = File(dirFor(inst), h(id) + ".tms"); val tmp = File(f.path + ".tmp")
        tmp.writeBytes(KeystoreVault.encrypt(plain, id.toByteArray())); tmp.renameTo(f)
        File(f.path + ".info").writeText(JSONObject().put("id", id).put("info", JSONObject(infoJson)).toString())
    }
    fun getSample(id: String): ByteArray? = find(id)?.let { runCatching { KeystoreVault.decrypt(it.readBytes(), id.toByteArray()) }.getOrNull() }
    fun hasSample(id: String) = find(id) != null
    fun deleteSample(id: String) { find(id)?.let { it.delete(); File(it.path + ".info").delete() } }
    fun listSamples(): String { val a = JSONArray(); samples.walkTopDown().filter { it.name.endsWith(".tms.info") }.forEach { runCatching { a.put(JSONObject(it.readText())) } }; return a.toString() }
    fun wipeSamples() { samples.deleteRecursively(); samples.mkdirs() }
    fun putMeta(k: String, v: String) { val f = File(meta, h(k) + ".json"); File(f.path + ".tmp").apply { writeText(v) }.renameTo(f) }
    fun getMeta(k: String): String = File(meta, h(k) + ".json").takeIf { it.exists() }?.readText() ?: ""
    fun deleteMeta(k: String) { File(meta, h(k) + ".json").delete() }
    fun storageInfo(): String = JSONObject().put("used", samples.walkTopDown().filter { it.isFile }.sumOf { it.length() }).put("quota", root.usableSpace).toString()
}
