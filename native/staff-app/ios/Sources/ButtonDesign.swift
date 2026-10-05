import SwiftUI

enum ActionTone { case primary, secondary, danger }

/// A shallow raised surface: depth is feedback, not extra layout space.
struct Primary: ButtonStyle {
  var tone: ActionTone = .primary
  var symbol: String? = nil
  @Environment(\.isEnabled) private var enabled
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @ScaledMetric(relativeTo: .body) private var labelSize = 16
  @ScaledMetric(relativeTo: .body) private var symbolSize = 17

  func makeBody(configuration: Configuration) -> some View {
    let pressed = enabled && configuration.isPressed
    let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
    let foreground =
      !enabled
      ? Color(hex: 0x858C84)
      : tone == .primary ? .white : tone == .danger ? Color(hex: 0x963E38) : ink
    let colors: [Color] =
      !enabled
      ? [Color(hex: 0xE8E9E3), Color(hex: 0xE1E3DC)]
      : tone == .primary
        ? [Color(hex: 0x2D4C3B), ink, Color(hex: 0x12251C)]
        : tone == .danger
          ? [Color(hex: 0xFFFCFA), Color(hex: 0xF8EEEA)] : [.white, Color(hex: 0xEEF2EB)]
    HStack(spacing: 9) {
      if let symbol {
        Image(systemName: symbol).font(.system(size: symbolSize, weight: .semibold)).accessibilityHidden(
          true)
      }
      configuration.label
        .fixedSize(horizontal: false, vertical: true)
    }
    .font(.system(size: labelSize, weight: .semibold))
    .multilineTextAlignment(.center)
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .frame(maxWidth: .infinity, minHeight: tone == .primary ? 50 : 44)
    .foregroundStyle(foreground)
    .background(LinearGradient(colors: colors, startPoint: .top, endPoint: .bottom), in: shape)
    .overlay(
      shape.strokeBorder(
        LinearGradient(
          colors: enabled && tone == .primary
            ? [gold.opacity(0.55), Color.white.opacity(0.06)]
            : [Color.white, foreground.opacity(enabled ? 0.18 : 0.08)], startPoint: .topLeading,
          endPoint: .bottomTrailing), lineWidth: 1)
    )
    .shadow(
      color: (tone == .danger ? Color(hex: 0x963E38) : ink).opacity(
        enabled ? (pressed ? 0.04 : 0.15) : 0), radius: pressed ? 1 : 4, x: 0, y: pressed ? 0 : 3
    )
    .scaleEffect(pressed && !reduceMotion ? 0.985 : 1)
    .offset(y: pressed && !reduceMotion ? 1 : 0)
    .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: pressed)
  }
}

struct RoundControl: ButtonStyle {
  var prominent = false
  @Environment(\.isEnabled) private var enabled
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  func makeBody(configuration: Configuration) -> some View {
    let pressed = enabled && configuration.isPressed
    configuration.label.font(.system(size: 17, weight: .semibold))
      .frame(width: 44, height: 44)
      .foregroundStyle(!enabled ? Color(hex: 0x92988F) : prominent ? .white : ink)
      .background {
        Circle().fill(
          LinearGradient(
            colors: !enabled
              ? [Color(hex: 0xE7E9E2), Color(hex: 0xE7E9E2)]
              : prominent ? [ink, Color(hex: 0x12251C)] : [.white, Color(hex: 0xEDF1E9)],
            startPoint: .top, endPoint: .bottom)
        ).padding(4)
      }
      .overlay(
        Circle().strokeBorder(
          prominent && enabled ? gold.opacity(0.45) : ink.opacity(0.15), lineWidth: 1
        ).padding(4)
      )
      .shadow(color: ink.opacity(enabled && !pressed ? 0.14 : 0), radius: 2, x: 0, y: 2)
      .scaleEffect(pressed && !reduceMotion ? 0.94 : 1)
      .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: pressed)
  }
}

struct CardPress: ButtonStyle {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .shadow(color: ink.opacity(configuration.isPressed ? 0 : 0.05), radius: 3, x: 0, y: 2)
      .opacity(configuration.isPressed ? 0.88 : 1)
      .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
      .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: configuration.isPressed)
  }
}
