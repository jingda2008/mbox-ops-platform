import SwiftUI

struct StaffTabBar: View {
  let destinations: [StaffDestination]
  @Binding var selection: Int
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  var body: some View {
    Group {
      if dynamicTypeSize.isAccessibilitySize {
        ScrollView(.horizontal) {
          HStack(spacing: 8) {
            ForEach(destinations) { destination in tab(destination).frame(minWidth: 96) }
          }.padding(.horizontal, 12)
        }.scrollIndicators(.hidden)
      } else {
        HStack(spacing: 0) {
          ForEach(destinations) { destination in tab(destination) }
        }.frame(maxWidth: 680).frame(maxWidth: .infinity)
      }
    }.padding(.vertical, 4).background(Color(hex: 0xFFFDFA))
  }
  private func tab(_ destination: StaffDestination) -> some View {
    let selected = destination.rawValue == selection
    return Button {
      selection = destination.rawValue
    } label: {
      VStack(spacing: 4) {
        Image(systemName: destination.icon).font(.title3)
          .frame(minWidth: 44, minHeight: 26)
          .background(selected ? ink.opacity(0.09) : .clear, in: Capsule())
        Text(destination.title).font(.caption.weight(selected ? .semibold : .regular))
          .lineLimit(2).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        Capsule().fill(selected ? gold : .clear).frame(width: 24, height: 2)
      }.padding(.horizontal, 4).frame(maxWidth: .infinity, minHeight: 58)
        .foregroundStyle(selected ? ink : Color.secondary).contentShape(Rectangle())
    }.buttonStyle(CardPress()).accessibilityLabel(destination.title)
      .accessibilityAddTraits(selected ? .isSelected : [])
  }
}
