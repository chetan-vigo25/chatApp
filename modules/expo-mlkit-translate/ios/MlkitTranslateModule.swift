import ExpoModulesCore
// There is no single umbrella `MLKit` Swift module for these APIs — each pod
// ships its own framework module:
//   MLKitTranslate  → Translator, TranslatorOptions, TranslateLanguage,
//                     TranslateRemoteModel, ModelManager.downloadedTranslateModels
//   MLKitLanguageID → LanguageIdentification
//   MLKitCommon     → ModelManager, ModelDownloadConditions,
//                     ModelDownloadUserInfoKey, the download notifications
import MLKitCommon
import MLKitLanguageID
import MLKitTranslate

struct TranslateArgs: Record {
  @Field var text: String = ""
  @Field var source: String = ""
  @Field var target: String = ""
  @Field var allowDownload: Bool = false
}

struct DownloadArgs: Record {
  @Field var language: String = ""
  @Field var requireWifi: Bool = true
}

final class UnsupportedLanguageException: GenericException<String> {
  override var reason: String { "ML Kit cannot translate \"\(param)\"." }
  override var code: String { "ERR_MLKIT_UNSUPPORTED_LANGUAGE" }
}

final class ModelMissingException: GenericException<String> {
  override var reason: String { "The on-device model for \"\(param)\" is not downloaded yet." }
  override var code: String { "ERR_MLKIT_MODEL_MISSING" }
}

final class TranslateFailedException: GenericException<String> {
  override var reason: String { param }
  override var code: String { "ERR_MLKIT_FAILED" }
}

/// Ceiling on a model download.
///
/// ML Kit reports downloads through NotificationCenter, and a download that
/// never posts either terminal notification would leave the promise unsettled
/// forever — which froze the language picker, because its rows stay disabled
/// while a download is in flight. Every download is therefore bounded.
private let downloadTimeout: TimeInterval = 180

public class MlkitTranslateModule: Module {

  /// A cached translator plus the bookkeeping that keeps it alive while in use.
  ///
  /// Dropping a translator mid-translate makes that call fail, so eviction
  /// cannot simply discard it: a busy entry is unlinked from the cache and
  /// marked, and the last in-flight call lets it go.
  private final class Entry {
    let translator: Translator
    var inUse: Int = 0
    var dropWhenIdle: Bool = false
    init(_ translator: Translator) { self.translator = translator }
  }

  /// Loaded translators keyed "source>target".
  ///
  /// Google documents a live translator as occupying 30–150MB of RAM, so this
  /// is deliberately tiny: a chat translates one direction at a time, so every
  /// message after the first reuses an instance.
  private var translators: [String: Entry] = [:]
  private var recency: [String] = []
  private let maxTranslators = 2
  private let lock = NSLock()

  private lazy var languageIdentifier = LanguageIdentification.languageIdentification()
  private lazy var modelManager = ModelManager.modelManager()

  /// BCP-47 tag → ML Kit language, or nil when unsupported.
  private func toMlkit(_ tag: String) -> TranslateLanguage? {
    let wanted = tag.lowercased()
    return TranslateLanguage.allLanguages().first { $0.rawValue.lowercased() == wanted }
  }

  private func acquire(source: TranslateLanguage, target: TranslateLanguage) -> Entry {
    lock.lock()
    defer { lock.unlock() }

    let key = "\(source.rawValue)>\(target.rawValue)"
    let entry: Entry
    if let existing = translators[key] {
      entry = existing
      recency.removeAll { $0 == key }
    } else {
      let options = TranslatorOptions(sourceLanguage: source, targetLanguage: target)
      entry = Entry(Translator.translator(options: options))
      translators[key] = entry
    }
    recency.append(key)
    entry.inUse += 1

    while recency.count > maxTranslators {
      let oldest = recency.removeFirst()
      if oldest == key { recency.append(oldest); break }  // never evict what we just took
      guard let evicted = translators.removeValue(forKey: oldest) else { continue }
      if evicted.inUse > 0 { evicted.dropWhenIdle = true }
    }
    return entry
  }

  private func release(_ entry: Entry) {
    lock.lock()
    entry.inUse -= 1
    lock.unlock()
  }

  private func closeAll() {
    lock.lock()
    translators.removeAll()
    recency.removeAll()
    lock.unlock()
  }

  private func isDownloaded(_ language: TranslateLanguage) -> Bool {
    let model = TranslateRemoteModel.translateRemoteModel(language: language)
    return modelManager.isModelDownloaded(model)
  }

  public func definition() -> ModuleDefinition {
    Name("MlkitTranslateModule")

    // Hand back the 30–150MB the translators hold when the app leaves the front.
    OnAppEntersBackground { self.closeAll() }
    OnDestroy { self.closeAll() }

    Function("getSupportedLanguages") { () -> [String] in
      TranslateLanguage.allLanguages().map { $0.rawValue }
    }

    AsyncFunction("identifyLanguage") { (text: String, promise: Promise) in
      self.languageIdentifier.identifyLanguage(for: text) { code, error in
        if let error = error {
          promise.reject(TranslateFailedException(error.localizedDescription))
          return
        }
        promise.resolve(code ?? "und")
      }
    }

    AsyncFunction("isModelDownloaded") { (language: String, promise: Promise) in
      guard let lang = self.toMlkit(language) else { promise.resolve(false); return }
      promise.resolve(self.isDownloaded(lang))
    }

    AsyncFunction("downloadModel") { (args: DownloadArgs, promise: Promise) in
      guard let lang = self.toMlkit(args.language) else {
        promise.reject(UnsupportedLanguageException(args.language)); return
      }
      let model = TranslateRemoteModel.translateRemoteModel(language: lang)
      if self.modelManager.isModelDownloaded(model) { promise.resolve(nil); return }

      let conditions = ModelDownloadConditions(
        allowsCellularAccess: !args.requireWifi,
        allowsBackgroundDownloading: true
      )

      // The iOS SDK reports completion through NotificationCenter rather than a
      // callback, so listen for this model's terminal event and settle exactly
      // once — including on a timeout, so a stalled download can never leave the
      // picker spinning forever.
      let settleLock = NSLock()
      var didSettle = false
      var observers: [NSObjectProtocol] = []
      var timeoutWork: DispatchWorkItem?

      func finish(_ block: @escaping () -> Void) {
        settleLock.lock()
        if didSettle { settleLock.unlock(); return }
        didSettle = true
        settleLock.unlock()

        timeoutWork?.cancel()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        block()
      }

      let matches: (Notification) -> Bool = { note in
        guard let downloaded = note.userInfo?[ModelDownloadUserInfoKey.remoteModel.rawValue]
                as? TranslateRemoteModel else { return false }
        return downloaded.language == lang
      }

      observers.append(NotificationCenter.default.addObserver(
        forName: .mlkitModelDownloadDidSucceed, object: nil, queue: nil
      ) { note in
        guard matches(note) else { return }
        finish { promise.resolve(nil) }
      })
      observers.append(NotificationCenter.default.addObserver(
        forName: .mlkitModelDownloadDidFail, object: nil, queue: nil
      ) { note in
        guard matches(note) else { return }
        let error = note.userInfo?[ModelDownloadUserInfoKey.error.rawValue] as? Error
        finish {
          promise.reject(TranslateFailedException(
            error?.localizedDescription ?? "Model download failed."))
        }
      })

      let work = DispatchWorkItem {
        // The download may still land later; the model check on the next attempt
        // will pick it up. What matters is that the caller is unblocked now.
        finish {
          promise.reject(TranslateFailedException(
            "Model download timed out after \(Int(downloadTimeout))s."))
        }
      }
      timeoutWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + downloadTimeout, execute: work)

      self.modelManager.download(model, conditions: conditions)
    }

    AsyncFunction("deleteModel") { (language: String, promise: Promise) in
      guard let lang = self.toMlkit(language) else {
        promise.reject(UnsupportedLanguageException(language)); return
      }
      let model = TranslateRemoteModel.translateRemoteModel(language: lang)
      self.modelManager.deleteDownloadedModel(model) { error in
        if let error = error {
          promise.reject(TranslateFailedException(error.localizedDescription))
          return
        }
        promise.resolve(nil)
      }
    }

    AsyncFunction("getDownloadedModels") { (promise: Promise) in
      promise.resolve(self.modelManager.downloadedTranslateModels.map { $0.language.rawValue })
    }

    AsyncFunction("translate") { (args: TranslateArgs, promise: Promise) in
      guard let source = self.toMlkit(args.source) else {
        promise.reject(UnsupportedLanguageException(args.source)); return
      }
      guard let target = self.toMlkit(args.target) else {
        promise.reject(UnsupportedLanguageException(args.target)); return
      }
      if source == target { promise.resolve(args.text); return }

      let entry = self.acquire(source: source, target: target)
      let settleLock = NSLock()
      var didSettle = false
      func settle(_ block: () -> Void) {
        settleLock.lock()
        if didSettle { settleLock.unlock(); return }
        didSettle = true
        settleLock.unlock()
        self.release(entry)
        block()
      }

      func run() {
        entry.translator.translate(args.text) { result, error in
          if let error = error {
            settle { promise.reject(TranslateFailedException(error.localizedDescription)) }
            return
          }
          settle { promise.resolve(result ?? args.text) }
        }
      }

      if args.allowDownload {
        // Explicit opt-in (the picker screen). Wi-Fi-only so a 30MB pull never
        // lands on someone's data plan without them asking for it.
        let conditions = ModelDownloadConditions(
          allowsCellularAccess: false, allowsBackgroundDownloading: true)
        entry.translator.downloadModelIfNeeded(with: conditions) { error in
          if let error = error {
            settle { promise.reject(TranslateFailedException(error.localizedDescription)) }
            return
          }
          run()
        }
        return
      }

      // Chat path: never block a bubble on a 30MB download. ML Kit pivots
      // through English, so BOTH endpoints must already be present.
      for lang in [source, target] where lang != .english {
        if !self.isDownloaded(lang) {
          settle { promise.reject(ModelMissingException(lang.rawValue)) }
          return
        }
      }
      run()
    }
  }
}
