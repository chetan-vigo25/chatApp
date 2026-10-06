package expo.modules.mediastore

import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * WhatsApp-style media storage:
 *   Android/media/<package>/TalksTry/Media/TalksTry Images/        (gallery-visible)
 *   Android/media/<package>/TalksTry/Media/TalksTry Images/Sent/   (.nomedia)
 *
 * The app owns its external media dir, so no storage permission is needed to
 * write there, and MediaStore indexes it (the gallery shows the files). The
 * chat and the gallery share ONE file — deleting it in the gallery removes it
 * from the chat too. expo-file-system can't create NEW files outside its
 * sandbox (its permission check needs an existing, writable file), hence this.
 */
class MediaStoreModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "React context unavailable", null)

  private fun mediaRoot(): File {
    val base = context.externalMediaDirs.firstOrNull { it != null } ?: context.getExternalFilesDir(null)
      ?: throw CodedException("ERR_NO_STORAGE", "External media storage unavailable", null)
    return File(base, "TalksTry/Media").apply { mkdirs() }
  }

  private fun toFile(uri: String): File {
    val path = if (uri.startsWith("file://")) Uri.parse(uri).path ?: uri.removePrefix("file://") else uri
    return File(path)
  }

  private fun uniqueTarget(dir: File, fileName: String): File {
    val safe = fileName.replace(Regex("[\\\\/:*?\"<>|]"), "_").ifBlank { "media" }
    var target = File(dir, safe)
    if (!target.exists()) return target
    val dot = safe.lastIndexOf('.')
    val stem = if (dot > 0) safe.substring(0, dot) else safe
    val ext = if (dot > 0) safe.substring(dot) else ""
    var n = 1
    while (target.exists()) {
      target = File(dir, "$stem($n)$ext")
      n++
    }
    return target
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoMediaStore")

    Function("getMediaRoot") {
      mediaRoot().absolutePath
    }

    AsyncFunction("saveToMedia") { srcUri: String, subDir: String, fileName: String, scan: Boolean, move: Boolean ->
      val src = toFile(srcUri)
      if (!src.exists()) throw CodedException("ERR_NO_SOURCE", "Source file not found: $srcUri", null)

      val dir = File(mediaRoot(), subDir).apply { mkdirs() }
      // Sent/ folders stay out of the gallery, exactly like WhatsApp.
      if (!scan) {
        val noMedia = File(dir, ".nomedia")
        if (!noMedia.exists()) runCatching { noMedia.createNewFile() }
      }

      val target = uniqueTarget(dir, fileName)
      val moved = move && runCatching { src.renameTo(target) }.getOrDefault(false)
      if (!moved) {
        src.inputStream().use { input -> target.outputStream().use { input.copyTo(it) } }
        if (move) runCatching { src.delete() }
      }

      if (scan) {
        MediaScannerConnection.scanFile(context, arrayOf(target.absolutePath), null, null)
      }
      Uri.fromFile(target).toString()
    }

    Function("fileExists") { uri: String ->
      runCatching { toFile(uri).let { it.exists() && it.length() > 0 } }.getOrDefault(false)
    }
  }
}
