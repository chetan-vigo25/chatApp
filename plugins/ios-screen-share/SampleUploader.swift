import CoreImage
import Foundation
import ReplayKit

private enum Constants {
  static let bufferMaxLength = 10240
}

/// Serializes each screen frame the way react-native-webrtc's ScreenCapturer
/// parses it: an HTTP-style message whose headers carry Content-Length and the
/// buffer size/orientation, with a JPEG body.
class SampleUploader {
  private static let imageContext = CIContext(options: nil)

  @Atomic private var isReady = false
  private let connection: SocketConnection
  private var dataToSend: Data?
  private var byteIndex = 0
  private let serialQueue = DispatchQueue(label: "com.chat.baatCheet.ScreenShare.uploader")

  init(connection: SocketConnection) {
    self.connection = connection
    setupConnection()
  }

  @discardableResult
  func send(sample buffer: CMSampleBuffer) -> Bool {
    guard isReady else { return false }
    isReady = false
    dataToSend = prepare(sample: buffer)
    byteIndex = 0
    serialQueue.async { [weak self] in
      self?.sendDataChunk()
    }
    return true
  }
}

private extension SampleUploader {
  func setupConnection() {
    connection.didOpen = { [weak self] in
      self?.isReady = true
    }
    connection.streamHasSpaceAvailable = { [weak self] in
      self?.serialQueue.async {
        if let pending = self?.sendDataChunk() {
          // Still sending this frame → not ready for the next one.
          self?.isReady = !pending
        }
      }
    }
  }

  /// Writes the next chunk; false when there was nothing queued.
  @discardableResult
  func sendDataChunk() -> Bool {
    guard let data = dataToSend else { return false }
    var bytesLeft = data.count - byteIndex
    var length = min(bytesLeft, Constants.bufferMaxLength)
    length = data[byteIndex..<(byteIndex + length)].withUnsafeBytes { raw -> Int in
      guard let ptr = raw.bindMemory(to: UInt8.self).baseAddress else { return 0 }
      return connection.writeToStream(buffer: ptr, maxLength: length)
    }
    if length > 0 {
      byteIndex += length
      bytesLeft -= length
      if bytesLeft == 0 {
        dataToSend = nil
        byteIndex = 0
      }
    }
    return true
  }

  func prepare(sample buffer: CMSampleBuffer) -> Data? {
    guard let imageBuffer = CMSampleBufferGetImageBuffer(buffer) else { return nil }

    CVPixelBufferLockBaseAddress(imageBuffer, .readOnly)
    // Half resolution: readable on the other side, and keeps the extension far
    // below its ~50 MB memory cap.
    let scaleFactor = 2.0
    let width = Int(Double(CVPixelBufferGetWidth(imageBuffer)) / scaleFactor)
    let height = Int(Double(CVPixelBufferGetHeight(imageBuffer)) / scaleFactor)
    let orientation = (CMGetAttachment(buffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil) as? NSNumber)?.uint32Value ?? 0
    let transform = CGAffineTransform(scaleX: CGFloat(1.0 / scaleFactor), y: CGFloat(1.0 / scaleFactor))
    let jpeg = jpegData(from: imageBuffer, scale: transform)
    CVPixelBufferUnlockBaseAddress(imageBuffer, .readOnly)

    guard let body = jpeg else { return nil }
    let message = CFHTTPMessageCreateResponse(nil, 200, nil, kCFHTTPVersion1_1).takeRetainedValue()
    CFHTTPMessageSetHeaderFieldValue(message, "Content-Length" as CFString, String(body.count) as CFString)
    CFHTTPMessageSetHeaderFieldValue(message, "Buffer-Width" as CFString, String(width) as CFString)
    CFHTTPMessageSetHeaderFieldValue(message, "Buffer-Height" as CFString, String(height) as CFString)
    CFHTTPMessageSetHeaderFieldValue(message, "Buffer-Orientation" as CFString, String(orientation) as CFString)
    CFHTTPMessageSetBody(message, body as CFData)
    return CFHTTPMessageCopySerializedMessage(message)?.takeRetainedValue() as Data?
  }

  func jpegData(from buffer: CVPixelBuffer, scale transform: CGAffineTransform) -> Data? {
    let image = CIImage(cvPixelBuffer: buffer).transformed(by: transform)
    guard let colorSpace = image.colorSpace else { return nil }
    let options: [CIImageRepresentationOption: Any] = [
      CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): 0.7,
    ]
    return SampleUploader.imageContext.jpegRepresentation(of: image, colorSpace: colorSpace, options: options)
  }
}
