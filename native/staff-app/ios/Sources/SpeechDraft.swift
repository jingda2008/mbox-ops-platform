import Foundation

/// A transcription is an editable draft, never a business command. Its owner is
/// the exact login/table context that requested recording, including after cancel.
struct SpeechDraft {
  private(set) var context: String?
  private(set) var requestID: UUID?
  private(set) var text = ""
  var active: Bool { requestID != nil }

  mutating func begin(context: String) -> UUID {
    let id = UUID()
    self.context = context
    requestID = id
    text = ""
    return id
  }
  mutating func receive(_ value: String, requestID: UUID) -> Bool {
    guard self.requestID == requestID else { return false }
    let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard clean.utf16.count <= 2000 else { return false }
    text = clean
    return true
  }
  mutating func stop() { requestID = nil }
  mutating func discard() { context = nil; requestID = nil; text = "" }
  func appending(to original: String, currentContext: String) throws -> String {
    guard context == currentContext, !active, !text.isEmpty else {
      throw SpeechDraftError("语音已失效或仍在录音，请重新录入并核对")
    }
    let original = original.trimmingCharacters(in: .whitespacesAndNewlines)
    let result = original.isEmpty ? text : original + "\n" + text
    guard result.utf16.count <= 2000 else {
      throw SpeechDraftError("合并后超过2000字，请缩短原文或重新录入，未覆盖已有文字")
    }
    return result
  }
}
struct SpeechDraftError: Error, LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
