import AppKit
import AVFoundation
import ScreenCaptureKit
import Vision

// vo-helper capture --out FILE.mp4 --pid PID [--audio-out FILE.mp4]
//   Records the main display, showing only PID and VoiceOver, until stdin closes.
// vo-helper ocr FILE.png...
//   Prints the text in each image as a JSON array.

struct Rect: Encodable { let x, y, width, height: Double }

func rect(_ frame: CGRect, in display: SCDisplay, scale: Double) -> Rect {
  Rect(
    x: (frame.minX - display.frame.minX) * scale, y: (frame.minY - display.frame.minY) * scale,
    width: frame.width * scale, height: frame.height * scale)
}

func emit<T: Encodable>(_ value: T) {
  let data = try! JSONEncoder().encode(value)
  FileHandle.standardOutput.write(data + Data("\n".utf8))
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("vo-helper: \(message)\n".utf8))
  exit(1)
}

func option(_ name: String) -> String? {
  guard let i = CommandLine.arguments.firstIndex(of: name), i + 1 < CommandLine.arguments.count else { return nil }
  return CommandLine.arguments[i + 1]
}

final class RecordingDelegate: NSObject, SCRecordingOutputDelegate, SCStreamDelegate {
  func recordingOutput(_ output: SCRecordingOutput, didFailWithError error: Error) { fail("recording failed: \(error)") }
  func stream(_ stream: SCStream, didStopWithError error: Error) { fail("stream stopped: \(error)") }
}

func makeStream(
  filter: SCContentFilter, config: SCStreamConfiguration, out: URL, delegate: RecordingDelegate
) throws -> SCStream {
  let stream = SCStream(filter: filter, configuration: config, delegate: delegate)
  let outputConfig = SCRecordingOutputConfiguration()
  outputConfig.outputURL = out
  outputConfig.outputFileType = .mp4
  outputConfig.videoCodecType = .h264
  try stream.addRecordingOutput(SCRecordingOutput(configuration: outputConfig, delegate: delegate))
  return stream
}

struct Ready: Encodable {
  let event = "ready"
  let scale: Double
  let display: Rect
  let window: Rect
  let captionPanel: Rect?
}

func capture() async throws {
  guard let out = option("--out"), let pid = option("--pid").flatMap(Int32.init) else {
    fail("usage: vo-helper capture --out FILE.mp4 --pid PID [--audio-out FILE.mp4]")
  }
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
    fail("main display not found")
  }
  let shown = content.applications.filter { $0.processID == pid || $0.bundleIdentifier == "com.apple.VoiceOver" }
  guard shown.contains(where: { $0.processID == pid }) else { fail("pid \(pid) has no capturable windows") }
  guard
    let window = content.windows
      .filter({ $0.owningApplication?.processID == pid && $0.windowLayer == 0 })
      .max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })
  else { fail("pid \(pid) has no on-screen window") }
  guard display.frame.contains(window.frame) else {
    fail("browser window \(window.frame) is not fully on the main display \(display.frame)")
  }
  // VoiceOver also owns a full-screen cursor overlay; the caption panel is its smallest window.
  let captionPanel = content.windows
    .filter { $0.owningApplication?.bundleIdentifier == "com.apple.VoiceOver" && $0.frame.width > 100 }
    .min(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height })

  let mode = CGDisplayCopyDisplayMode(display.displayID)
  let scale = Double(mode?.pixelWidth ?? display.width * 2) / Double(display.width)
  let config = SCStreamConfiguration()
  config.width = Int(Double(display.width) * scale)
  config.height = Int(Double(display.height) * scale)
  config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
  config.showsCursor = false

  let delegate = RecordingDelegate()
  var streams = [
    try makeStream(
      filter: SCContentFilter(display: display, including: shown, exceptingWindows: []),
      config: config, out: URL(fileURLWithPath: out), delegate: delegate)
  ]
  // VoiceOver speaks through a system XPC service, so audio needs an unfiltered stream.
  if let audioOut = option("--audio-out") {
    let audioConfig = SCStreamConfiguration()
    audioConfig.width = 2
    audioConfig.height = 2
    audioConfig.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    audioConfig.capturesAudio = true
    audioConfig.sampleRate = 48000
    audioConfig.channelCount = 2
    streams.append(
      try makeStream(
        filter: SCContentFilter(display: display, excludingApplications: [], exceptingWindows: []),
        config: audioConfig, out: URL(fileURLWithPath: audioOut), delegate: delegate))
  }
  for stream in streams { try await stream.startCapture() }
  emit(
    Ready(
      scale: scale, display: rect(display.frame, in: display, scale: scale),
      window: rect(window.frame, in: display, scale: scale),
      captionPanel: captionPanel.map { rect($0.frame, in: display, scale: scale) }))

  while readLine() != nil {}
  for stream in streams { try await stream.stopCapture() }
  try await Task.sleep(nanoseconds: 1_000_000_000)
  emit(["event": "done"])
}

func ocr() throws {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = false
  var texts: [String] = []
  for path in CommandLine.arguments.dropFirst(2) {
    try VNImageRequestHandler(url: URL(fileURLWithPath: path)).perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    texts.append(lines.joined(separator: " "))
  }
  emit(texts)
}

switch CommandLine.arguments.dropFirst().first {
case "capture":
  // ScreenCaptureKit adds a menu bar item, which needs a running AppKit main loop.
  NSApplication.shared.setActivationPolicy(.prohibited)
  Task {
    do { try await capture() } catch { fail("\(error)") }
    exit(0)
  }
  NSApplication.shared.run()
case "ocr":
  do { try ocr() } catch { fail("\(error)") }
default:
  fail("usage: vo-helper capture|ocr ...")
}
