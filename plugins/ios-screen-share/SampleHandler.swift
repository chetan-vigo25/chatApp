import ReplayKit

private enum Constants {
  // Shared with the app (Info.plist RTCAppGroupIdentifier) — react-native-webrtc
  // opens its socket at <container>/rtc_SSFD.
  static let appGroupIdentifier = "group.com.chat.baatCheet.share"
  static let socketName = "rtc_SSFD"
  // How long to wait for the app's socket before giving up (the user started
  // the broadcast from Control Center with no call running).
  static let connectTimeoutTicks = 100 // × 100 ms
}

/// ReplayKit Broadcast Upload Extension: forwards the whole-screen capture to
/// the TalksTry app, which sends it into the call as the screen-share track.
class SampleHandler: RPBroadcastSampleHandler {
  private var clientConnection: SocketConnection?
  private var uploader: SampleUploader?
  private var frameCount = 0
  private var connectTimer: DispatchSourceTimer?

  private var socketFilePath: String {
    let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Constants.appGroupIdentifier)
    return container?.appendingPathComponent(Constants.socketName).path ?? ""
  }

  override init() {
    super.init()
    if let connection = SocketConnection(filePath: socketFilePath) {
      clientConnection = connection
      setupConnection()
      uploader = SampleUploader(connection: connection)
    }
  }

  override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
    frameCount = 0
    openConnection()
  }

  override func broadcastPaused() {}

  override func broadcastResumed() {}

  override func broadcastFinished() {
    connectTimer?.cancel()
    clientConnection?.close()
  }

  override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
    guard sampleBufferType == .video else { return }
    // ~20 fps of 60: plenty for a shared screen, cheap on the extension.
    frameCount += 1
    if frameCount % 3 == 0 {
      uploader?.send(sample: sampleBuffer)
    }
  }
}

private extension SampleHandler {
  func setupConnection() {
    clientConnection?.didClose = { [weak self] error in
      if let error = error {
        self?.finishBroadcastWithError(error)
      } else {
        // The app stopped the share (or the call ended). NSError reads better
        // in the system's "broadcast stopped" alert than a bare Error.
        let stopped = NSError(domain: RPRecordingErrorDomain, code: 10001,
                              userInfo: [NSLocalizedDescriptionKey: "Screen sharing stopped"])
        self?.finishBroadcastWithError(stopped)
      }
    }
  }

  func openConnection() {
    let queue = DispatchQueue(label: "com.chat.baatCheet.ScreenShare.connect")
    let timer = DispatchSource.makeTimerSource(queue: queue)
    var ticks = 0
    timer.schedule(deadline: .now(), repeating: .milliseconds(100), leeway: .milliseconds(500))
    timer.setEventHandler { [weak self] in
      guard let self = self else { timer.cancel(); return }
      if self.clientConnection?.open() == true {
        timer.cancel()
        return
      }
      ticks += 1
      if ticks >= Constants.connectTimeoutTicks {
        timer.cancel()
        let noCall = NSError(domain: RPRecordingErrorDomain, code: 10002,
                             userInfo: [NSLocalizedDescriptionKey: "Start screen sharing from a TalksTry video call."])
        self.finishBroadcastWithError(noCall)
      }
    }
    connectTimer = timer
    timer.resume()
  }
}
