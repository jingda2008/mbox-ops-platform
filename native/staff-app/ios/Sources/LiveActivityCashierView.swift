import SwiftUI

struct ActivityCashierCard: View {
  @EnvironmentObject var model: AppModel
  let registration: CashierActivity
  @Binding var proposed: LiveCommand?
  @State private var provider = "cash"
  @State private var reference = ""
  @State private var terminal = ""
  @State private var method = "bank_transfer"
  @State private var reason = ""
  func act(_ action: String, payment: String = "") {
    do {
      proposed = try model.prepareActivity(
        registrationID: registration.id, action: action, provider: provider, reference: reference,
        terminal: terminal, externalMethod: method, reason: reason, paymentPublicID: payment,
        confirmed: action == "collect")
    } catch { model.message = error.localizedDescription }
  }
  var body: some View {
    Foldout(title: "活动 · \(registration.activityTitle) · \(money(registration.due))") {
      Text("\(registration.publicId) · \(registration.partySize)人").font(.caption).textSelection(
        .enabled)
      Text("\(registration.startsAt) · \(cashierStatus(registration.paymentStatus))").font(.caption)
      if model.cashier?.actions["supportsGuardedActivityCashier"] != true {
        Text("活动资金操作需要后台升级，当前只供核对原记录。").font(.caption)
      }
      TextField("操作原因或收款说明", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder)
      if registration.onlinePending { Text("原线上付款待确认，其他收款入口已锁定。请先查询原款。") }
      if registration.refunded && registration.recollectionAuthorization == nil
        && registration.late.isEmpty
      {
        Button("授权活动重新收款") { act("recollect") }.buttonStyle(
          Primary(tone: .secondary, symbol: "checkmark.shield")
        ).disabled(!model.canUseActivity)
      }
      if let authorization = registration.recollectionAuthorization {
        Text("授权一次 \(money(authorization.amountMinor)) · 截止 \(authorization.expiresAt)").font(
          .caption)
      }
      if registration.canCollect {
        Picker("实际收款方式", selection: $provider) {
          Text("现金").tag("cash")
          Text("实体POS").tag("physical_pos")
          Text("其他线下").tag("external_manual")
        }
        if provider != "cash" {
          TextField("独立收款凭证号", text: $reference).textFieldStyle(.roundedBorder)
        }
        if provider == "physical_pos" {
          TextField("POS终端编号", text: $terminal).textFieldStyle(.roundedBorder)
        }
        if provider == "external_manual" {
          Picker("具体方式", selection: $method) {
            Text("银行转账").tag("bank_transfer")
            Text("其他钱包").tag("mobile_wallet")
            Text("储值凭证").tag("stored_value_voucher")
            Text("公司账户").tag("corporate_account")
            Text("其他批准方式").tag("other")
          }
        }
        Button("已实际收到 \(money(registration.due)) · 核对登记") { act("collect") }.buttonStyle(
          Primary(symbol: "creditcard")
        ).disabled(!model.canUseActivity)
      }
      if let payment = registration.payment {
        Text("原付款 \(payment.publicId) · \(cashierStatus(payment.status))").font(.caption)
        if payment.provider == "postar" {
          Button("查询原活动付款") { paymentAction(payment, "payment-query") }.buttonStyle(
            Primary(tone: .secondary, symbol: "arrow.clockwise"))
        }
        if payment.remainingRefundableMinor > 0
          && payment.refunds.allSatisfy({ ["failed", "rejected", "cancelled"].contains($0.status) })
        {
          Button("申请活动原款全额退款") { act("refund") }.buttonStyle(
            Primary(tone: .secondary, symbol: "arrow.uturn.backward")
          ).disabled(!model.canUseActivity)
        }
        if registration.onlinePending {
          Button("核对渠道并关闭原活动付款") { paymentAction(payment, "payment-close", note: reason) }
            .buttonStyle(Primary(tone: .secondary, symbol: "xmark.shield"))
        }
        ForEach(payment.refunds) { refund in
          CashierRefundCard(refund: refund, payment: payment) { action, note, ref, ok in
            paymentAction(payment, action, refundID: refund.id, note: note, ref: ref, ok: ok)
          }
        }
      }
      ForEach(registration.late) { late in
        if let payment = late.payment {
          ForEach(payment.refunds) { refund in
            CashierRefundCard(refund: refund, payment: payment) { action, note, ref, ok in
              paymentAction(payment, action, refundID: refund.id, note: note, ref: ref, ok: ok)
            }
          }
        }
        Text(
          "迟到旧款 \(late.publicId) · 待退 \(money(late.remainingRefundableMinor)) · \(cashierStatus(late.refundStatus ?? "succeeded"))"
        ).font(.caption)
        if late.refundStatus == nil
          || ["failed", "rejected", "cancelled"].contains(late.refundStatus!)
        {
          Button("申请退回这笔迟到旧款") { act("refund", payment: late.publicId) }.buttonStyle(
            Primary(tone: .secondary, symbol: "arrow.uturn.backward")
          ).disabled(!model.canUseActivity)
        }
      }
    }
  }
  func paymentAction(
    _ payment: LiveCashier.Payment, _ action: String, refundID: String = "", note: String = "",
    ref: String = "", ok: Bool = true
  ) {
    do {
      proposed = try model.prepareCashier(
        orderID: registration.id, paymentID: payment.id, action: action, refundID: refundID,
        reason: note, reference: ref, succeeded: ok)
    } catch { model.message = error.localizedDescription }
  }
}
