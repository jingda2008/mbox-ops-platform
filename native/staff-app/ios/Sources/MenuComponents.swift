import SwiftUI

struct MenuDestination: Identifiable {
  let session, tableCode: String
  var id: String { session }
}
struct MenuFilters: View {
  @Binding var query: String
  @Binding var category: String
  let categories: [(String, String)]
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      TextField("搜索菜品、套餐或编码", text: $query).textFieldStyle(.roundedBorder).autocorrectionDisabled()
        .accessibilityIdentifier("menu.search")
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          chip("全部菜单", code: "")
          ForEach(categories, id: \.0) { chip($0.1, code: $0.0) }
        }.padding(.vertical, 2)
      }
    }
  }
  func chip(_ title: String, code: String) -> some View {
    Button {
      category = code
    } label: {
      Text(title).font(.subheadline.weight(.semibold)).padding(.horizontal, 16).padding(
        .vertical, 12
      )
      .foregroundStyle(category == code ? Color.white : ink)
      .background(category == code ? ink : Color.white, in: Capsule())
      .overlay(
        Capsule().stroke(category == code ? gold.opacity(0.65) : gold.opacity(0.25), lineWidth: 1))
    }.buttonStyle(.plain).accessibilityAddTraits(category == code ? .isSelected : [])
  }
}
struct MenuThumbnail: View {
  let name: String
  var url: URL? = nil
  var body: some View {
    AsyncImage(url: url) { phase in
      if let image = phase.image {
        image.resizable().scaledToFill()
      } else {
        ZStack {
          LinearGradient(
            colors: [ink.opacity(0.08), gold.opacity(0.16)], startPoint: .topLeading,
            endPoint: .bottomTrailing)
          Image(systemName: "fork.knife").font(.title2).foregroundStyle(ink.opacity(0.6))
        }
      }
    }.frame(width: 76, height: 76).clipShape(RoundedRectangle(cornerRadius: 12))
      .accessibilityHidden(true)
  }
}
