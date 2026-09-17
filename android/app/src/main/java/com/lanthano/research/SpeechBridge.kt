package com.lanthano.research

import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap

/**
 * Android WebView has no working Web Speech synthesis, so the site's Read Aloud
 * feature is backed by the device's own TextToSpeech engine. Only voices that
 * are installed on the device (no network synthesis) are offered.
 *
 * [emitJs] is called with JavaScript to run in the page; progress is reported
 * to window.__lanthanoApp._tts(token, type, charIndex, charLength).
 */
class SpeechBridge(
    private val context: Context,
    private val emitJs: (String) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()

    @Volatile private var tts: TextToSpeech? = null
    @Volatile private var starting = false
    @Volatile var isReady = false
        private set
    @Volatile var hasFailed = false
        private set
    @Volatile var voicesJson = "[]"
        private set
    @Volatile private var activeToken: String? = null

    private data class Chunk(val token: String, val offset: Int, val first: Boolean, val last: Boolean)

    private val chunks = ConcurrentHashMap<String, Chunk>()

    /** Starts the engine if needed. Safe to call from any thread, any number of times. */
    fun warmUp() {
        main.post {
            if (tts != null || starting || hasFailed) return@post
            starting = true
            // onInit may run synchronously inside the constructor, before `tts`
            // is assigned, so the real work is posted to run afterwards.
            tts = TextToSpeech(context.applicationContext) { status ->
                main.post { finishInit(status) }
            }
        }
    }

    private fun finishInit(status: Int) {
        starting = false
        val engine = tts ?: return
        if (status != TextToSpeech.SUCCESS) {
            hasFailed = true
            isReady = false
            try {
                engine.shutdown()
            } catch (e: Exception) {
                // ignore
            }
            tts = null
        } else {
            engine.setOnUtteranceProgressListener(listener)
            voicesJson = buildVoicesJson(engine)
            isReady = true
        }
        emitJs("window.__lanthanoApp&&window.__lanthanoApp._ttsReady&&window.__lanthanoApp._ttsReady()")
    }

    private fun usableVoices(engine: TextToSpeech): List<Voice> {
        val all: Set<Voice> = try {
            engine.voices ?: emptySet()
        } catch (e: Exception) {
            emptySet()
        }
        return all.filter { voice ->
            !voice.isNetworkConnectionRequired &&
                !voice.features.orEmpty().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)
        }
    }

    private fun buildVoicesJson(engine: TextToSpeech): String {
        val defaultName = try {
            engine.defaultVoice?.name
        } catch (e: Exception) {
            null
        }
        val array = JSONArray()
        usableVoices(engine)
            .sortedWith(compareBy<Voice>({ it.locale.toLanguageTag() }, { it.name }))
            .forEach { voice ->
                val tag = voice.locale.toLanguageTag()
                val shortName = voice.name
                    .removePrefix(tag.lowercase(Locale.ROOT) + "-x-")
                    .removeSuffix("-local")
                val label = voice.locale.getDisplayName(Locale.getDefault()) + " \u00b7 " + shortName
                array.put(
                    JSONObject()
                        .put("name", label)
                        .put("voiceURI", voice.name)
                        .put("lang", tag)
                        .put("default", voice.name == defaultName),
                )
            }
        return array.toString()
    }

    /** Speaks [text]; returns false if it could not be started. Called on the JS bridge thread. */
    fun start(
        token: String,
        text: String,
        voiceUri: String,
        lang: String,
        rate: Double,
        pitch: Double,
        volume: Double,
    ): Boolean {
        val engine = tts
        if (engine == null || !isReady) return false
        return synchronized(lock) {
            activeToken = token
            chunks.clear()
            engine.stop()

            val voice = if (voiceUri.isNotEmpty()) usableVoices(engine).firstOrNull { it.name == voiceUri } else null
            if (voice != null) {
                engine.setVoice(voice)
            } else if (lang.isNotEmpty()) {
                engine.setLanguage(Locale.forLanguageTag(lang))
            }
            engine.setSpeechRate(rate.toFloat().coerceIn(0.1f, 6f))
            engine.setPitch(pitch.toFloat().coerceIn(0.1f, 2f))

            val params = Bundle()
            params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume.toFloat().coerceIn(0f, 1f))

            val pieces = split(text, TextToSpeech.getMaxSpeechInputLength() - 1)
            pieces.forEachIndexed { index, (offset, piece) ->
                val id = "$token#$index"
                chunks[id] = Chunk(token, offset, first = index == 0, last = index == pieces.lastIndex)
                val mode = if (index == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
                if (engine.speak(piece, mode, params, id) != TextToSpeech.SUCCESS) {
                    chunks.remove(id)
                    if (index == 0) {
                        activeToken = null
                        return false
                    }
                }
            }
            true
        }
    }

    fun stop() {
        synchronized(lock) {
            activeToken = null
            chunks.clear()
            try {
                tts?.stop()
            } catch (e: Exception) {
                // ignore
            }
        }
    }

    fun shutdown() {
        stop()
        main.post {
            try {
                tts?.shutdown()
            } catch (e: Exception) {
                // ignore
            }
            tts = null
            isReady = false
        }
    }

    /** Splits text longer than the engine limit at whitespace; returns (offset, piece) pairs. */
    private fun split(text: String, maxLength: Int): List<Pair<Int, String>> {
        val limit = maxOf(maxLength, 200)
        if (text.length <= limit) return listOf(0 to text)
        val result = ArrayList<Pair<Int, String>>()
        var start = 0
        while (start < text.length) {
            var end = minOf(start + limit, text.length)
            if (end < text.length) {
                val space = text.lastIndexOf(' ', end)
                if (space > start + limit / 2) end = space + 1
            }
            result += start to text.substring(start, end)
            start = end
        }
        return result
    }

    private fun emit(token: String, type: String, charIndex: Int, charLength: Int) {
        if (token != activeToken) return
        emitJs(
            "window.__lanthanoApp&&window.__lanthanoApp._tts(" +
                JSONObject.quote(token) + "," + JSONObject.quote(type) + "," + charIndex + "," + charLength + ")",
        )
    }

    private val listener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {
            val chunk = utteranceId?.let { chunks[it] } ?: return
            if (chunk.first) emit(chunk.token, "start", 0, 0)
        }

        override fun onDone(utteranceId: String?) {
            val chunk = utteranceId?.let { chunks.remove(it) } ?: return
            if (chunk.last) emit(chunk.token, "end", 0, 0)
        }

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) {
            fail(utteranceId)
        }

        override fun onError(utteranceId: String?, errorCode: Int) {
            fail(utteranceId)
        }

        override fun onStop(utteranceId: String?, interrupted: Boolean) {
            utteranceId?.let { chunks.remove(it) }
        }

        override fun onRangeStart(utteranceId: String?, start: Int, end: Int, frame: Int) {
            val chunk = utteranceId?.let { chunks[it] } ?: return
            emit(chunk.token, "boundary", chunk.offset + start, maxOf(0, end - start))
        }

        private fun fail(utteranceId: String?) {
            val chunk = utteranceId?.let { chunks.remove(it) } ?: return
            emit(chunk.token, "error", 0, 0)
        }
    }
}
