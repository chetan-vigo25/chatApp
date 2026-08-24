Pod::Spec.new do |s|
  s.name           = 'ExpoMlkitTranslate'
  s.version        = '1.0.0'
  s.summary        = 'Google ML Kit on-device translation + language identification'
  s.description    = 'Expo native module wrapping ML Kit Translate and LanguageID.'
  s.author         = ''
  s.homepage       = 'https://developers.google.com/ml-kit/language/translation'
  s.license        = { :type => 'MIT' }
  # ML Kit 8.x refuses to build below 15.5 — the app's deployment target is
  # raised to match in app.json (expo-build-properties).
  s.platforms      = { :ios => '15.5' }
  s.source         = { git: '' }

  # GoogleMLKit ships static frameworks; without this CocoaPods tries to build
  # it as a dynamic framework and linking fails.
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'GoogleMLKit/Translate', '8.0.0'
  s.dependency 'GoogleMLKit/LanguageID', '8.0.0'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
