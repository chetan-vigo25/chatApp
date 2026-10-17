Pod::Spec.new do |s|
  s.name           = 'ExpoScreenBroadcast'
  s.version        = '1.0.0'
  s.summary        = 'ReplayKit broadcast picker for TalksTry screen share'
  s.description    = 'Presents RPSystemBroadcastPickerView preselected to the app broadcast extension.'
  s.author         = ''
  s.homepage       = 'https://developer.apple.com/documentation/replaykit'
  s.license        = { :type => 'MIT' }
  s.platforms      = { :ios => '15.5' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ReplayKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift}"
end
