package expo.modules.mlkittranslate

import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.nl.languageid.LanguageIdentification
import com.google.mlkit.nl.languageid.LanguageIdentifier
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.TranslateRemoteModel
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.Translator
import com.google.mlkit.nl.translate.TranslatorOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class TranslateArgs : Record {
  @Field var text: String = ""
  @Field var source: String = ""
  @Field var target: String = ""
  @Field var allowDownload: Boolean = false
}

class DownloadArgs : Record {
  @Field var language: String = ""
  @Field var requireWifi: Boolean = true
}

internal class UnsupportedLanguageException(tag: String) :
  CodedException("ERR_MLKIT_UNSUPPORTED_LANGUAGE", "ML Kit cannot translate \"$tag\".", null)

internal class ModelMissingException(tag: String) :
  CodedException(
    "ERR_MLKIT_MODEL_MISSING",
    "The on-device model for \"$tag\" is not downloaded yet.",
    null,
  )

internal class TranslateFailedException(cause: Throwable?) :
  CodedException("ERR_MLKIT_FAILED", cause?.message ?: "ML Kit translation failed.", cause)

class MlkitTranslateModule : Module() {

  /**
   * A cached translator plus the bookkeeping that keeps it alive while in use.
   *
   * Closing a translator mid-translate makes that call fail, so eviction cannot
   * simply call close(): a busy entry is unlinked from the cache and marked, and
   * the last in-flight call closes it on the way out.
   */
  private class Entry(val translator: Translator) {
    var inUse: Int = 0
    var closeWhenIdle: Boolean = false
  }

  /**
   * Loaded translators, keyed "source>target".
   *
   * Google documents a live translator as occupying 30–150MB of RAM, so these
   * are NOT kept per language pair. A chat translates one direction at a time,
   * so a tiny cache gets every message after the first for free.
   */
  private val translators = LinkedHashMap<String, Entry>()
  private val maxTranslators = 2

  private val languageIdentifier: LanguageIdentifier by lazy {
    LanguageIdentification.getClient()
  }

  private val modelManager: RemoteModelManager by lazy { RemoteModelManager.getInstance() }

  /** BCP-47 tag → ML Kit's internal constant, or null when unsupported. */
  private fun toMlkit(tag: String): String? = TranslateLanguage.fromLanguageTag(tag)

  @Synchronized
  private fun acquire(source: String, target: String): Entry {
    val key = "$source>$target"
    val entry = translators.remove(key) ?: Entry(
      Translation.getClient(
        TranslatorOptions.Builder()
          .setSourceLanguage(source)
          .setTargetLanguage(target)
          .build(),
      ),
    )
    translators[key] = entry                 // re-insert = most recently used
    entry.inUse += 1

    while (translators.size > maxTranslators) {
      val oldestKey = translators.keys.first()
      if (oldestKey == key) break            // never evict what we just acquired
      val evicted = translators.remove(oldestKey) ?: continue
      if (evicted.inUse == 0) evicted.translator.close() else evicted.closeWhenIdle = true
    }
    return entry
  }

  @Synchronized
  private fun release(entry: Entry) {
    entry.inUse -= 1
    if (entry.inUse <= 0 && entry.closeWhenIdle) entry.translator.close()
  }

  @Synchronized
  private fun closeAll() {
    translators.values.forEach {
      if (it.inUse == 0) it.translator.close() else it.closeWhenIdle = true
    }
    translators.clear()
  }

  override fun definition() = ModuleDefinition {
    Name("MlkitTranslateModule")

    // Free the translators (and their 30–150MB) when the app goes away.
    OnActivityDestroys { closeAll() }
    OnDestroy { closeAll() }

    Function("getSupportedLanguages") {
      TranslateLanguage.getAllLanguages()
    }

    AsyncFunction("identifyLanguage") { text: String, promise: Promise ->
      languageIdentifier.identifyLanguage(text)
        .addOnSuccessListener { code -> promise.resolve(code ?: "und") }
        .addOnFailureListener { error -> promise.reject(TranslateFailedException(error)) }
    }

    AsyncFunction("isModelDownloaded") { language: String, promise: Promise ->
      val tag = toMlkit(language)
      if (tag == null) { promise.resolve(false); return@AsyncFunction }
      modelManager.isModelDownloaded(TranslateRemoteModel.Builder(tag).build())
        .addOnSuccessListener { downloaded -> promise.resolve(downloaded) }
        .addOnFailureListener { promise.resolve(false) }
    }

    AsyncFunction("downloadModel") { args: DownloadArgs, promise: Promise ->
      val tag = toMlkit(args.language)
      if (tag == null) {
        promise.reject(UnsupportedLanguageException(args.language)); return@AsyncFunction
      }
      val conditions = DownloadConditions.Builder().apply {
        if (args.requireWifi) requireWifi()
      }.build()
      // A Task can only settle once, but guard anyway: a promise resolved twice
      // is a hard crash in Expo, and this one is driven by callbacks.
      val settled = AtomicBoolean(false)
      modelManager.download(TranslateRemoteModel.Builder(tag).build(), conditions)
        .addOnSuccessListener { if (settled.compareAndSet(false, true)) promise.resolve(null) }
        .addOnFailureListener { error ->
          if (settled.compareAndSet(false, true)) promise.reject(TranslateFailedException(error))
        }
    }

    AsyncFunction("deleteModel") { language: String, promise: Promise ->
      val tag = toMlkit(language)
      if (tag == null) {
        promise.reject(UnsupportedLanguageException(language)); return@AsyncFunction
      }
      modelManager.deleteDownloadedModel(TranslateRemoteModel.Builder(tag).build())
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { error -> promise.reject(TranslateFailedException(error)) }
    }

    AsyncFunction("getDownloadedModels") { promise: Promise ->
      modelManager.getDownloadedModels(TranslateRemoteModel::class.java)
        .addOnSuccessListener { models -> promise.resolve(models.map { it.language }) }
        .addOnFailureListener { error -> promise.reject(TranslateFailedException(error)) }
    }

    AsyncFunction("translate") { args: TranslateArgs, promise: Promise ->
      val source = toMlkit(args.source)
      val target = toMlkit(args.target)
      if (source == null) {
        promise.reject(UnsupportedLanguageException(args.source)); return@AsyncFunction
      }
      if (target == null) {
        promise.reject(UnsupportedLanguageException(args.target)); return@AsyncFunction
      }
      if (source == target) { promise.resolve(args.text); return@AsyncFunction }

      val entry = acquire(source, target)
      val settled = AtomicBoolean(false)
      fun settle(block: () -> Unit) {
        if (settled.compareAndSet(false, true)) { release(entry); block() }
      }

      fun run() {
        entry.translator.translate(args.text)
          .addOnSuccessListener { result -> settle { promise.resolve(result) } }
          .addOnFailureListener { error -> settle { promise.reject(TranslateFailedException(error)) } }
      }

      if (args.allowDownload) {
        // Explicit opt-in (the picker screen). Wi-Fi-only so a 30MB pull never
        // lands on someone's data plan without them asking for it.
        entry.translator.downloadModelIfNeeded(DownloadConditions.Builder().requireWifi().build())
          .addOnSuccessListener { run() }
          .addOnFailureListener { error -> settle { promise.reject(TranslateFailedException(error)) } }
        return@AsyncFunction
      }

      // Chat path: never block a bubble on a 30MB download. Report the miss and
      // let JS decide (it kicks off the picker's download instead).
      //
      // ML Kit pivots through English, so BOTH endpoints must be present. The
      // checks run concurrently, so the counter and the first-miss slot are
      // atomic rather than plain vars — ML Kit happens to call these back on the
      // main looper today, but nothing in the API promises that.
      val needed = listOf(source, target).filter { it != TranslateLanguage.ENGLISH }
      if (needed.isEmpty()) { run(); return@AsyncFunction }
      val remaining = AtomicInteger(needed.size)
      val missing = AtomicReference<String?>(null)
      val failure = AtomicReference<Throwable?>(null)
      needed.forEach { tag ->
        modelManager.isModelDownloaded(TranslateRemoteModel.Builder(tag).build())
          .addOnSuccessListener { downloaded ->
            if (!downloaded) missing.compareAndSet(null, tag)
            if (remaining.decrementAndGet() == 0) {
              val absent = missing.get()
              when {
                absent != null -> settle { promise.reject(ModelMissingException(absent)) }
                failure.get() != null -> settle { promise.reject(TranslateFailedException(failure.get())) }
                else -> run()
              }
            }
          }
          .addOnFailureListener { error ->
            failure.compareAndSet(null, error)
            if (remaining.decrementAndGet() == 0) {
              val absent = missing.get()
              if (absent != null) settle { promise.reject(ModelMissingException(absent)) }
              else settle { promise.reject(TranslateFailedException(error)) }
            }
          }
      }
    }
  }
}
