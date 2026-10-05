import SwiftUI

struct LiveShowCatalogView: View {
  @EnvironmentObject var model: AppModel
  let board: ShowBoard, performer: ShowRow, usable: Bool
  let propose: (() throws -> LiveCommand) -> Void
  @State private var catalog: ShowCatalog?
  @State private var search = ""
  @State private var appliedSearch = ""
  @State private var offset = 0
  @State private var selected: ShowRow?
  @State private var code = ""
  @State private var title = ""
  @State private var aliases = ""
  @State private var status = "active"
  @State private var songLines = ""
  @State private var mode = "upsert"
  @State private var notice = ""
  @State private var reading = false
  private func load(_ page: Int = 0, query: String? = nil) async {
    reading = true; selected = nil
    defer { reading = false }
    do {
      guard let actor = model.identity else { throw StaffAPIError.invalid }
      let term = query ?? search
      guard term.utf16.count <= 120 else { throw CatalogError("搜索词最多120字") }
      let path = showRoot + "/performers/" + performer.id + "/songs?offset=\(page)&search=" + LiveCommand.pathPart(term)
      let bytes = try await model.readShow(path)
      catalog = try ShowCatalog(bytes, actor: actor, performerID: performer.id); offset = page; appliedSearch = term; notice = "已读取完整曲库中的当前页。"
    } catch { catalog = nil; notice = error.localizedDescription }
  }
  var body: some View {
    Card {
      Text(performer.text("stageName") + " · 曲库").font(.title3.bold())
      TextField("搜索歌名、编号或别名", text: $search).textFieldStyle(.roundedBorder)
      Button(reading ? "正在读取…" : "查询完整曲库") { Task { await load() } }.disabled(reading || !usable)
      if !notice.isEmpty { Text(notice).font(.subheadline) }
      if let catalog {
        Text("所查范围 \(catalog.total) 首；演员完整曲库 \(catalog.totalSongs) 首。").font(.subheadline)
        ForEach(catalog.songs) { song in
          VStack(alignment: .leading, spacing: 6) {
            Text(song.text("title") + " · " + (song.text("status") == "active" ? "启用" : "停用")).font(.headline)
            Text("编号：" + (song.text("code").isEmpty ? "无编号" : song.text("code")) + " · 点歌" + song.text("requestCount") + "次 / 演唱" + song.text("performedCount") + "次").font(.caption)
            if model.identity?.allows("song.manage") == true {
              Button("编辑这首曲目") { selected = song; code = song.text("code"); title = song.text("title"); aliases = (song.object["aliases"] as? [String] ?? []).joined(separator: "，"); status = song.text("status") }.disabled(!usable || reading)
            }
          }
        }
        HStack {
          if offset > 0 { Button("上一页") { Task { await load(max(0, offset - 100), query: appliedSearch) } }.disabled(reading || !usable) }
          if let next = catalog.nextOffset { Button("下一页") { Task { await load(next, query: appliedSearch) } }.disabled(reading || !usable) }
        }
        if model.identity?.allows("song.manage") == true {
          if let selected {
            DisclosureGroup("编辑原曲目：" + selected.text("title"), isExpanded: .constant(true)) {
              TextField("编号（可留空）", text: $code).textFieldStyle(.roundedBorder)
              TextField("歌名", text: $title).textFieldStyle(.roundedBorder)
              TextField("别名，逗号分隔", text: $aliases, axis: .vertical).textFieldStyle(.roundedBorder)
              Picker("状态", selection: $status) { Text("启用").tag("active"); Text("停用").tag("inactive") }
              Button("核对并保存曲目") {
                propose {
                  guard let actor = model.identity else { throw StaffAPIError.invalid }
                  let changes: [String: Any] = ["code": code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? NSNull() : code.trimmingCharacters(in: .whitespacesAndNewlines),
                    "title": title.trimmingCharacters(in: .whitespacesAndNewlines), "aliases": aliases.components(separatedBy: CharacterSet(charactersIn: ",，")).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }, "status": status]
                  return try board.command(actor: actor, action: "song-update", body: ["songId": selected.id, "expected": selected.text("configurationFingerprint"), "changes": changes],
                    confirmation: "修改原曲目\n演员：" + performer.text("stageName") + "\n歌名：" + title + "\n编号：" + code + "\n别名：" + aliases + "\n状态：" + (status == "active" ? "启用" : "停用"), catalog: catalog)
                }
              }.disabled(!usable || reading)
            }
          }
          DisclosureGroup("批量追加或替换完整曲库") {
            Text("每行：编号 | 歌名 | 别名1,别名2；也可每行只填歌名。每次最多5000首。").font(.subheadline)
            TextEditor(text: $songLines).frame(minHeight: 180).overlay(RoundedRectangle(cornerRadius: 8).stroke(.gray.opacity(0.4)))
            Picker("导入方式", selection: $mode) { Text("追加或更新").tag("upsert"); Text("替换全部可用曲库").tag("replace") }
            if mode == "replace" { Text("未列出的歌曲会停用；空清单会停用全部曲目，历史点歌记录仍保留。").foregroundStyle(.orange) }
            Button("核对完整导入清单") {
              propose {
                guard let actor = model.identity else { throw StaffAPIError.invalid }
                let songs = try parseShowSongs(songLines)
                let body: [String: Any] = ["performerId": performer.id, "expected": catalog.fingerprint, "sourceName": "iOS员工曲库维护", "mode": mode, "songs": songs]
                let detail = songs.prefix(20).map { showText($0, "title") }.joined(separator: "\n")
                return try board.command(actor: actor, action: "songs-import", body: body,
                  confirmation: (mode == "replace" ? "替换全部可用曲库" : "追加或更新曲库") + "\n演员：" + performer.text("stageName") + "\n本次\(songs.count)首，原完整曲库\(catalog.totalSongs)首\n" + (mode == "replace" ? "未列出的曲目将停用，请核对完整清单。" : "按编号或歌名匹配更新，保留其他曲目。") + "\n" + detail + (songs.count > 20 ? "\n其余请返回原清单核对。" : ""), catalog: catalog)
              }
            }.buttonStyle(Primary(symbol: "music.note.list")).disabled(!usable || reading)
          }
        }
      }
    }.task { await load() }
  }
}
