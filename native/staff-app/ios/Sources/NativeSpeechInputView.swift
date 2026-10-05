#if os(iOS)
import AVFoundation
import Speech
import SwiftUI

@MainActor final class NativeSpeechCapture: ObservableObject {
  @Published private(set) var draft = SpeechDraft()
  @Published private(set) var notice = ""
  @Published private(set) var recording = false
  private var engine: AVAudioEngine?
  private var tapInstalled = false
  private var ownsAudioSession = false
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var recognition: SFSpeechRecognitionTask?
  private var timeLimit: Task<Void, Never>?

  func start(context: String, stillAllowed: @escaping () -> Bool) async {
    cancel()
    guard stillAllowed() else { notice = "请先刷新本桌资料并核对登录"; return }
    let id = draft.begin(context: context)
    notice = "正在核对麦克风和语音权限"
    let speech = await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
    }
    guard draft.requestID == id else { return }
    guard stillAllowed() else { cancel(); return }
    guard speech == .authorized else {
      cancel(); notice = "未允许语音识别，可继续手动输入"; return
    }
    let microphone = await AVCaptureDevice.requestAccess(for: .audio)
    guard draft.requestID == id else { return }
    guard stillAllowed() else { cancel(); return }
    guard microphone else { cancel(); notice = "未允许麦克风，可继续手动输入"; return }
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "zh-CN")),
      recognizer.isAvailable, recognizer.supportsOnDeviceRecognition
    else { cancel(); notice = "本设备当前不能在本机识别中文，可继续手动输入"; return }
    do {
      let audioSession = AVAudioSession.sharedInstance()
      try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
      try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
      ownsAudioSession = true
      let engine = AVAudioEngine()
      self.engine = engine
      let input = engine.inputNode
      let format = input.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0 else {
        throw SpeechDraftError("麦克风当前不可用，可继续手动输入")
      }
      let request = SFSpeechAudioBufferRecognitionRequest()
      request.requiresOnDeviceRecognition = true
      request.shouldReportPartialResults = true
      self.request = request
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        request.append(buffer)
      }
      tapInstalled = true
      recognition = recognizer.recognitionTask(with: request) { [weak self] result, error in
        Task { @MainActor [weak self] in
          guard let self, self.draft.requestID == id else { return }
          guard stillAllowed() else { self.cancel(); return }
          if let result {
            let accepted = self.draft.receive(result.bestTranscription.formattedString, requestID: id)
            if !accepted {
              self.cancel(); self.notice = "语音超过2000字，已停止，请分段录入"; return
            }
          }
          if result?.isFinal == true || error != nil {
            self.stop()
            self.notice = self.draft.text.isEmpty
              ? "未识别到文字，请重试或手动输入"
              : "录音已结束，请核对下方文字后使用"
          }
        }
      }
      engine.prepare()
      try engine.start()
      recording = true
      notice = "正在录音，最长45秒；点击停止后核对文字"
      timeLimit = Task { [weak self] in
        try? await Task.sleep(for: .seconds(45))
        guard !Task.isCancelled, let self, self.draft.requestID == id else { return }
        self.stop()
      }
    } catch {
      cancel()
      notice = "录音未能开始，可重试或手动输入"
    }
  }
  func stop() {
    draft.stop() // Invalidate before cancellation can enqueue a late callback.
    timeLimit?.cancel(); timeLimit = nil
    engine?.stop()
    if tapInstalled, let engine { engine.inputNode.removeTap(onBus: 0) }
    tapInstalled = false
    engine = nil
    request?.endAudio(); request = nil
    recognition?.cancel(); recognition = nil
    recording = false
    if ownsAudioSession {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      ownsAudioSession = false
    }
    notice = draft.text.isEmpty ? "未识别到文字，可重试或手动输入" : "请核对下方文字后使用"
  }
  func cancel() { stop(); draft.discard(); notice = "" }
}

struct NativeSpeechInputView: View {
  @Environment(\.scenePhase) private var scenePhase
  @StateObject private var capture = NativeSpeechCapture()
  @State private var error = ""
  let context: String
  let enabled: Bool
  let stillAllowed: () -> Bool
  @Binding var text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if capture.draft.active {
        Button(capture.recording ? "停止录音并核对" : "取消语音输入") {
          capture.recording ? capture.stop() : capture.cancel()
        }.buttonStyle(Primary(tone: .secondary, symbol: "stop.circle"))
      } else {
        Button("语音记录现场观察") {
          error = ""
          Task { await capture.start(context: context, stillAllowed: stillAllowed) }
        }.buttonStyle(Primary(tone: .secondary, symbol: "mic"))
          .disabled(!enabled)
      }
      Text("音频仅在本机识别、不保存；文字需核对后才加入输入框。").font(.caption)
        .foregroundStyle(.secondary)
      if !capture.notice.isEmpty { Text(capture.notice).font(.caption) }
      if !error.isEmpty { Text(error).foregroundStyle(.red) }
      if !capture.draft.text.isEmpty {
        Text(capture.draft.text).textSelection(.enabled)
        if !capture.draft.active {
          HStack {
            Button("核对后加入输入框") {
              do {
                guard enabled, stillAllowed() else {
                  throw SpeechDraftError("登录、权限或本桌资料已变化，请重新核对")
                }
                text = try capture.draft.appending(to: text, currentContext: context)
                capture.cancel()
                error = ""
              } catch { self.error = error.localizedDescription }
            }.disabled(!enabled)
            Button("舍弃") { capture.cancel(); error = "" }
          }
        }
      }
    }
    .onChange(of: context) { _, _ in capture.cancel(); error = "" }
    .onChange(of: enabled) { _, value in if !value { capture.cancel() } }
    .onChange(of: scenePhase) { _, value in if value != .active { capture.cancel() } }
    .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in
      if capture.draft.active { capture.stop() }
    }
    .onDisappear { capture.cancel() }
  }
}
#endif
