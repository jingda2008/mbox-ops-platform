#!/bin/bash
set -euo pipefail
base=$(cd "$(dirname "$0")" && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
cp -R "$base/Sources" "$test_dir/Sources"
cp "$base/Tests/MembershipRecoveryTests.swift" "$test_dir/MembershipRecoveryTests.swift"
swiftc "$test_dir/Sources/Domain.swift" "$test_dir/Sources/StaffAPI.swift" "$test_dir/Sources/LiveStock.swift" "$test_dir/Sources/LiveProductManagement.swift" "$test_dir/Sources/LiveObservation.swift" "$test_dir/Sources/LiveMembers.swift" "$test_dir/Sources/SessionPersistence.swift" "$test_dir/Sources/LiveParticipants.swift" "$test_dir/Sources/LiveReservations.swift" "$test_dir/Sources/LiveService.swift" "$test_dir/Sources/LiveCashHandover.swift" "$test_dir/Sources/LiveVouchers.swift" "$test_dir/Sources/LivePrinting.swift" "$test_dir/Sources/LiveAfterSales.swift" "$test_dir/Sources/LiveActivityCashier.swift" "$test_dir/Sources/LiveOnlinePayment.swift" "$test_dir/Sources/LiveFinance.swift" "$test_dir/Sources/LiveBenefitWallet.swift" "$test_dir/Sources/MembershipFields.swift" "$test_dir/Sources/LiveMembershipConfig.swift" "$test_dir/Sources/LiveMembershipRecovery.swift" "$test_dir/Sources/LiveAssignments.swift" "$test_dir/Sources/LiveOperations.swift" "$test_dir/Sources/LiveCommand.swift" "$test_dir/Sources/LiveCatalog.swift" "$test_dir/Sources/LiveOrdering.swift" "$test_dir/Sources/LivePickup.swift" "$test_dir/Sources/LiveCashier.swift" "$test_dir/Sources/LiveCollection.swift" "$test_dir/Sources/LiveKitchen.swift" "$test_dir/Sources/LiveHistory.swift" "$test_dir/Sources/HistoryExport.swift" "$test_dir/MembershipRecoveryTests.swift" -o "$test_dir/membership-recovery-tests"
"$test_dir/membership-recovery-tests" "$base/../shared/fixtures"
