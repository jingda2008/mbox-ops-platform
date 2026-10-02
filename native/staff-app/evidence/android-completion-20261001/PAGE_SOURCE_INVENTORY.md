# Android 页面源码清点与设备验收边界

本表由 scripts/inventory-android-pages.py 生成。仅清点页面函数和源码标记，不能证明布局正确、键盘未遮挡或读屏顺序正确。AlertDialog 使用系统对话框布局，安全区/键盘计数为0也不直接判定缺陷。

每页仍需在真实设备核验：正常/空白/无权/离线/未知结果，大字与横屏，键盘和返回操作；拍照/扫码/语音还须真实设备及权限拒绝核验。任何一项不能仅凭构建通过标为完成。

| 源码 | 页面/选择器 | 文本输入 | 安全区标记 | 键盘标记 |
| --- | --- | --- | --- | --- |
| AppUpdateView.kt | AppUpdateView | 0 | 0 | 0 |
| LiveAccountView.kt | LiveAccountView, StaffLoginScreen | 3 | 1 | 1 |
| LiveActivityOperationsView.kt | LiveActivityOperationsView | 0 | 2 | 1 |
| LiveAfterSalesView.kt | AfterSalesCenterView, LiveAfterSalesView | 7 | 3 | 1 |
| LiveAnnualEditor.kt | AnnualOptionPicker | 0 | 1 | 1 |
| LiveAnnualPoliciesView.kt | LiveAnnualPoliciesView, AnnualOccurrencesView | 0 | 3 | 2 |
| LiveAssignmentsView.kt | AssignmentDatePicker, LiveAssignmentsView | 3 | 2 | 1 |
| LiveBenefitExceptionsView.kt | LiveBenefitExceptionsView | 0 | 1 | 1 |
| LiveBenefitWalletView.kt | LiveBenefitWalletView | 0 | 1 | 1 |
| LiveBenefitsView.kt | LiveBenefitsView | 2 | 1 | 1 |
| LiveBusinessReportsView.kt | LiveBusinessReportsView | 5 | 1 | 1 |
| LiveCashHandoverView.kt | LiveCashHandoverView | 6 | 1 | 1 |
| LiveCashierView.kt | LiveCashierView, HistoricalCollectionView | 12 | 2 | 2 |
| LiveCatalogConfigurationView.kt | LiveCategoryConfigurationView, LiveProductConfigurationView, ProductConfigurationPicker | 0 | 3 | 3 |
| LiveCatalogView.kt | LiveCatalogView, LiveProductPicker | 1 | 1 | 1 |
| LiveCheckoutEditors.kt | CheckoutProductPicker | 2 | 1 | 1 |
| LiveCheckoutManagementView.kt | LiveCheckoutManagementView | 0 | 1 | 1 |
| LiveCollectionView.kt | LiveCollectionView | 5 | 1 | 1 |
| LiveCommercePolicyView.kt | LiveCommercePolicyView | 0 | 1 | 1 |
| LiveContactGovernanceView.kt | LiveContactGovernanceView | 0 | 1 | 1 |
| LiveCouponCalendarsView.kt | LiveCouponCalendarsView | 3 | 1 | 1 |
| LiveCouponRefundsView.kt | LiveCouponRefundsView | 0 | 1 | 1 |
| LiveCustodyView.kt | LiveCustodyView | 1 | 1 | 1 |
| LiveDevicesView.kt | LiveDevicesView | 6 | 1 | 1 |
| LiveExperiencePlansView.kt | LiveExperiencePlansView | 0 | 1 | 1 |
| LiveFinanceView.kt | LiveFinanceView | 2 | 2 | 1 |
| LiveFulfillmentHistoryView.kt | LiveFulfillmentHistoryView | 0 | 1 | 1 |
| LiveFulfillmentView.kt | LiveFulfillmentView | 2 | 2 | 2 |
| LiveHistoryView.kt | LiveHistoryView | 6 | 0 | 0 |
| LiveHomeContentView.kt | LiveHomeContentView | 1 | 1 | 1 |
| LiveKitchenBatchView.kt | LiveKitchenBatchView, KitchenTimerView | 1 | 1 | 1 |
| LiveKitchenView.kt | LiveKitchenView, LiveKitchenHandoffView | 2 | 2 | 2 |
| LiveLaunchPopupView.kt | LiveLaunchPopupView | 1 | 1 | 1 |
| LiveLoyaltyRefundsView.kt | LiveLoyaltyRefundsView | 0 | 1 | 1 |
| LiveLoyaltySupplementsView.kt | LiveLoyaltySupplementsView | 0 | 1 | 1 |
| LiveMarketingView.kt | LiveMarketingView, MarketingCustomerPicker | 3 | 2 | 2 |
| LiveMediaAssetPicker.kt | LiveMediaAssetPicker | 0 | 1 | 0 |
| LiveMemberCardsView.kt | LiveMemberCardsView | 0 | 1 | 1 |
| LiveMemberGiftsView.kt | LiveMemberGiftsView, GiftOptionPicker | 0 | 2 | 2 |
| LiveMemberNumberView.kt | LiveMemberNumberView | 0 | 1 | 1 |
| LiveMembersView.kt | LiveMembersView | 3 | 1 | 1 |
| LiveMembershipConfigView.kt | LiveMembershipConfigView, MembershipImpactView | 0 | 1 | 1 |
| LiveMembershipOverviewView.kt | LiveMembershipOverviewView | 0 | 1 | 0 |
| LiveMembershipRecoveryView.kt | LiveMembershipRecoveryView, MembershipRecoveryPicker | 1 | 2 | 1 |
| LiveObservationView.kt | LiveObservationView | 3 | 1 | 1 |
| LiveOnlinePaymentView.kt | LiveOnlinePaymentView | 3 | 2 | 1 |
| LiveOverviewView.kt | LiveOverviewView | 1 | 1 | 1 |
| LiveOwnerFinanceView.kt | LiveOwnerFinanceView | 0 | 1 | 1 |
| LiveParticipantsView.kt | LiveParticipantsView | 3 | 1 | 1 |
| LivePerformanceView.kt | LivePerformanceView | 0 | 1 | 1 |
| LivePickupView.kt | LivePickupView | 1 | 1 | 1 |
| LivePrintingView.kt | LivePrintingView | 4 | 1 | 1 |
| LiveProductManagementView.kt | LiveProductManagementView | 4 | 2 | 2 |
| LiveProductOperationsView.kt | LiveProductOperationsView | 0 | 1 | 1 |
| LiveProductPhasesView.kt | LiveProductPhasesView | 0 | 1 | 1 |
| LivePublicationView.kt | LivePublicationView | 1 | 1 | 1 |
| LiveRecipeConfigurationView.kt | LiveRecipeConfigurationView | 0 | 1 | 1 |
| LiveRecommendationPoliciesView.kt | LiveRecommendationPoliciesView | 1 | 1 | 1 |
| LiveRemakeHandoverView.kt | LiveRemakeHandoverView | 0 | 1 | 1 |
| LiveReservationsView.kt | LiveReservationsView | 4 | 1 | 1 |
| LiveServiceRecoveryView.kt | LiveServiceRecoveryView | 3 | 1 | 1 |
| LiveServiceView.kt | LiveServiceView | 2 | 2 | 2 |
| LiveSocialOperationsView.kt | LiveSocialOperationsView | 2 | 1 | 1 |
| LiveSongsView.kt | LiveSongsView | 2 | 1 | 1 |
| LiveStackingPoliciesView.kt | LiveStackingPoliciesView | 0 | 1 | 1 |
| LiveStaffAdministrationView.kt | LiveStaffAdministrationView | 1 | 1 | 1 |
| LiveStockAuditView.kt | LiveStockAuditView | 5 | 1 | 1 |
| LiveStockView.kt | LiveStockView | 4 | 1 | 1 |
| LiveTableActions.kt | LivePendingView | 4 | 0 | 0 |
| LiveTableConfigurationView.kt | LiveTableConfigurationView | 0 | 1 | 1 |
| LiveVouchersView.kt | LiveVouchersView | 8 | 1 | 1 |
| MainActivity.kt | StaffApp, Tables, MenuScreen, More | 2 | 1 | 1 |
| ReservationCreateView.kt | ReservationCreateView | 4 | 1 | 1 |
| ServiceReminderView.kt | ServiceReminderView | 0 | 0 | 0 |
