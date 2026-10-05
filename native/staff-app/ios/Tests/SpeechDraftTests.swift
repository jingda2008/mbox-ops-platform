import Foundation

@main struct SpeechDraftTests {
  static func main() throws {
    var count = 0
    func check(_ value: Bool, _ label: String) { precondition(value, label); count += 1 }
    func rejects(_ work: () throws -> String) -> Bool { do { _ = try work(); return false } catch { return true } }
    var draft = SpeechDraft()
    let first = draft.begin(context: "employee-a|login-1|table-1")
    check(draft.receive("  客人说有点甜  ", requestID: first), "recognition accepted for original context")
    check(rejects { try draft.appending(to: "", currentContext: "employee-a|login-1|table-1") }, "live audio cannot submit a draft")
    draft.stop()
    check(!draft.receive("迟到回调覆盖", requestID: first), "stopped session ignores late transcription")
    check(try draft.appending(to: "已有现场记录", currentContext: "employee-a|login-1|table-1") == "已有现场记录\n客人说有点甜", "accept preserves original text and adds reviewed candidate")
    check(rejects { try draft.appending(to: "", currentContext: "employee-b|login-2|table-1") }, "employee switch cannot accept previous speech")
    check(rejects { try draft.appending(to: "", currentContext: "employee-a|login-2|table-1") }, "renewed login requires a new recording")
    check(rejects { try draft.appending(to: "", currentContext: "employee-a|login-1|table-2") }, "speech cannot move to another table")
    check(rejects { try draft.appending(to: String(repeating: "客", count: 2000), currentContext: "employee-a|login-1|table-1") }, "overlong merge rejects without truncating old text")
    let second = draft.begin(context: "employee-a|login-1|table-1")
    check(!draft.receive("前一次回调", requestID: first) && draft.text.isEmpty, "restart invalidates original recognition even in same login")
    check(!draft.receive(String(repeating: "😀", count: 1001), requestID: second), "UTF16 limit matches server input length")
    check(draft.receive("\n  ", requestID: second), "empty interim result accepted without inventing text")
    draft.stop()
    check(rejects { try draft.appending(to: "", currentContext: "employee-a|login-1|table-1") }, "empty final transcript cannot be used")
    let third = draft.begin(context: "employee-a|login-1|table-1")
    _ = draft.receive("候选文字", requestID: third)
    draft.discard()
    check(draft.text.isEmpty && draft.context == nil && !draft.active, "background/logout discard removes unsaved candidate")
    check(!draft.receive("取消后到达", requestID: third), "discard cancels asynchronous callback")
    print("\(count) speech draft lifecycle checks passed")
  }
}
