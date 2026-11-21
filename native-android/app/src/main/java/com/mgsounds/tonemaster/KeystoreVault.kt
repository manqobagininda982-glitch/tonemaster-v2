package com.mgsounds.tonemaster

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** AES-256-GCM key that lives in the Android Keystore (hardware-backed / StrongBox where available). The key can never be read out. */
object KeystoreVault {
    private const val ALIAS = "tonemaster_library_key_v1"
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        fun gen(strongBox: Boolean): SecretKey {
            val b = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256)
            if (strongBox && android.os.Build.VERSION.SDK_INT >= 28) b.setIsStrongBoxBacked(true)
            return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(b.build()) }.generateKey()
        }
        return try { gen(true) } catch (e: Exception) { gen(false) }
    }
    /** returns iv(12) + ciphertext+tag. [aad] binds the ciphertext to its sample id. */
    fun encrypt(plain: ByteArray, aad: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()); updateAAD(aad) }
        return c.iv + c.doFinal(plain)
    }
    fun decrypt(blob: ByteArray, aad: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, blob, 0, 12)); updateAAD(aad) }
        return c.doFinal(blob, 12, blob.size - 12)
    }
    /** Stable per-installation device id (random, stored encrypted by the Keystore key). Changes if the app data is wiped. */
}
