package com.mgsounds.tonemaster

import android.content.Context
import android.media.midi.*
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject

/** USB MIDI (USB-OTG class-compliant keyboards) → JavaScript. Uses android.media.midi, which does NOT depend on Chrome/WebView Web MIDI. */
class MidiBridge(private val ctx: Context, private val web: WebView) {
    private val mm = ctx.getSystemService(Context.MIDI_SERVICE) as MidiManager
    private val ui = Handler(Looper.getMainLooper())
    private val open = HashMap<Int, Pair<MidiDevice, MidiOutputPort>>()
    private var started = false

    fun available() = ctx.packageManager.hasSystemFeature("android.software.midi")
    fun start() {
        if (started) return; started = true
        mm.registerDeviceCallback(object : MidiManager.DeviceCallback() {
            override fun onDeviceAdded(d: MidiDeviceInfo) { openDevice(d) }
            override fun onDeviceRemoved(d: MidiDeviceInfo) { close(d.id); publish() }
        }, ui)
        mm.devices.forEach { openDevice(it) }; publish()
    }
    private fun openDevice(info: MidiDeviceInfo) {
        if (info.outputPortCount == 0 || open.containsKey(info.id)) return          // keyboards expose OUTPUT ports (device → host)
        mm.openDevice(info, { dev ->
            if (dev == null) return@openDevice
            val port = dev.openOutputPort(0) ?: run { dev.close(); return@openDevice }
            val id = info.id.toString(); val parser = Parser { s, a, b -> ui.post { web.evaluateJavascript("window.ToneMasterMidi&&ToneMasterMidi.message('$id',$s,$a,$b)", null) } }
            port.connect(object : MidiReceiver() { override fun onSend(data: ByteArray, offset: Int, count: Int, timestamp: Long) { parser.feed(data, offset, count) } })
            open[info.id] = Pair(dev, port); publish()
        }, ui)
    }
    private fun close(id: Int) { open.remove(id)?.let { runCatching { it.second.close(); it.first.close() } } }
    private fun name(i: MidiDeviceInfo) = i.properties.getString(MidiDeviceInfo.PROPERTY_NAME) ?: "USB MIDI device"
    private fun publish() {
        val a = JSONArray(); mm.devices.filter { open.containsKey(it.id) }.forEach { a.put(JSONObject().put("id", it.id.toString()).put("name", name(it))) }
        ui.post { web.evaluateJavascript("window.ToneMasterMidi&&ToneMasterMidi.devices(${JSONObject.quote(a.toString())})", null) }
    }
    /** Minimal MIDI byte-stream parser (running status, 2/3-byte channel messages; realtime/sysex ignored). */
    private class Parser(val emit: (Int, Int, Int) -> Unit) {
        var status = 0; val d = IntArray(2); var n = 0
        fun feed(b: ByteArray, off: Int, cnt: Int) {
            for (i in off until off + cnt) {
                val v = b[i].toInt() and 0xFF
                if (v >= 0xF8) continue
                if (v >= 0xF0) { status = 0; n = 0; continue }
                if (v >= 0x80) { status = v; n = 0; continue }
                if (status == 0) continue
                d[n++] = v; val need = if ((status and 0xF0) == 0xC0 || (status and 0xF0) == 0xD0) 1 else 2
                if (n == need) { emit(status, d[0], if (need == 2) d[1] else 0); n = 0 }
            }
        }
    }
}
