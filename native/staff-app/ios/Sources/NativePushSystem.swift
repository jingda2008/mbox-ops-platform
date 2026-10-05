#if canImport(UIKit)
import UIKit
import UserNotifications

@MainActor final class IOSNativePushSystem: NativePushSystem {
  private func map(_ status: UNAuthorizationStatus) -> NativePushPermission {
    switch status {
    case .authorized: return .authorized
    case .provisional: return .provisional
    case .notDetermined: return .notDetermined
    default: return .denied
    }
  }
  func permission() async -> NativePushPermission {
    map(await UNUserNotificationCenter.current().notificationSettings().authorizationStatus)
  }
  func requestPermission() async throws -> NativePushPermission {
    if await permission() == .notDetermined {
      _ = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
    }
    return await permission()
  }
  func register() { UIApplication.shared.registerForRemoteNotifications() }
  func stopAndClear() {
    UIApplication.shared.unregisterForRemoteNotifications()
    let center = UNUserNotificationCenter.current()
    center.removeAllDeliveredNotifications()
    center.removeAllPendingNotificationRequests()
    center.setBadgeCount(0) { _ in }
  }
}
/// Stores only opaque click IDs before SwiftUI has attached its coordinator.
/// No task payload is treated as an authorization or automatically executed.
@MainActor final class NativePushEventBridge {
  static let shared = NativePushEventBridge()
  weak var coordinator: NativePushCoordinator?
  private var coldOpen: String?
  func attach(_ coordinator: NativePushCoordinator) {
    self.coordinator = coordinator
    if let id = coldOpen {
      coldOpen = nil
      Task { await coordinator.clicked(id) }
    }
  }
  func clicked(_ id: String) {
    guard let coordinator else { coldOpen = id; return }
    Task { await coordinator.clicked(id) }
  }
}
final class NativePushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(_ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    // A remote launch is not necessarily a user tap. Only the response callback
    // below queues an open; this avoids claiming an unobserved user action.
    return true
  }
  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    Task { @MainActor in await NativePushEventBridge.shared.coordinator?.registered(token: deviceToken) }
  }
  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    // Do not log NSError metadata; it may contain platform/device details.
    Task { @MainActor in NativePushEventBridge.shared.coordinator?.registrationFailed() }
  }
  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    Task { @MainActor in
      guard let id = NativePushCoordinator.deliveryId(notification.request.content.userInfo),
        let coordinator = NativePushEventBridge.shared.coordinator, coordinator.canPresent else {
        completionHandler([]); return
      }
      completionHandler([.banner, .list, .sound])
      await coordinator.received(id)
    }
  }
  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void) {
    Task { @MainActor in
      if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
        let id = NativePushCoordinator.deliveryId(response.notification.request.content.userInfo) {
        NativePushEventBridge.shared.clicked(id)
      }
      completionHandler()
    }
  }
}
#endif
