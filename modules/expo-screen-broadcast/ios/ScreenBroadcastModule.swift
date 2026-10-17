import ExpoModulesCore
import ReplayKit
import UIKit

/// iOS has no API to start a ReplayKit broadcast directly: the user must
/// confirm in the system sheet that RPSystemBroadcastPickerView opens. This
/// module hosts an invisible picker preselected to the TalksTry extension
/// (Info.plist RTCScreenSharingExtension) and taps its button — the same trick
/// react-native-webrtc's own picker uses, without needing the legacy bridge.
public class ScreenBroadcastModule: Module {
  private var picker: RPSystemBroadcastPickerView?

  private var extensionId: String? {
    return Bundle.main.object(forInfoDictionaryKey: "RTCScreenSharingExtension") as? String
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoScreenBroadcast")

    Function("isAvailable") { () -> Bool in
      return self.extensionId != nil
        && Bundle.main.object(forInfoDictionaryKey: "RTCAppGroupIdentifier") != nil
    }

    AsyncFunction("showPicker") { (promise: Promise) in
      guard let ext = self.extensionId else {
        promise.reject("ERR_NO_EXTENSION", "This build has no screen-share extension")
        return
      }
      guard let window = Self.keyWindow() else {
        promise.reject("ERR_NO_WINDOW", "No active window to present the broadcast picker")
        return
      }
      self.picker?.removeFromSuperview()
      let picker = RPSystemBroadcastPickerView(frame: CGRect(x: -100, y: -100, width: 44, height: 44))
      picker.preferredExtension = ext
      picker.showsMicrophoneButton = false
      picker.alpha = 0.011
      window.addSubview(picker)
      self.picker = picker

      guard let button = picker.subviews.compactMap({ $0 as? UIButton }).first else {
        picker.removeFromSuperview()
        self.picker = nil
        promise.reject("ERR_NO_PICKER_BUTTON", "Broadcast picker button not found")
        return
      }
      button.sendActions(for: .touchUpInside)
      promise.resolve(true)
    }.runOnQueue(.main)
  }

  private static func keyWindow() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState == .foregroundActive }
    return scenes.flatMap { $0.windows }.first { $0.isKeyWindow }
      ?? scenes.first?.windows.first
  }
}
