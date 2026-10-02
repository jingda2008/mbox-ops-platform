#!/bin/bash
set -euo pipefail
base=$(cd "$(dirname "$0")" && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
swiftc "$base/Sources/Domain.swift" "$base/Sources/StaffAPI.swift" "$base/Sources/LiveStock.swift" "$base/Sources/LiveProductManagement.swift" "$base/Sources/LiveObservation.swift" "$base/Sources/LiveMembers.swift" "$base/Sources/SessionPersistence.swift" "$base/Sources/LiveParticipants.swift" "$base/Sources/LiveReservations.swift" "$base/Sources/LiveService.swift" "$base/Sources/LiveCashHandover.swift" "$base/Sources/LiveVouchers.swift" "$base/Sources/LivePrinting.swift" "$base/Sources/LiveAfterSales.swift" "$base/Sources/LiveActivityCashier.swift" "$base/Sources/LiveOnlinePayment.swift" "$base/Sources/LiveFinance.swift" "$base/Sources/LiveAssignments.swift" "$base/Sources/LiveOperations.swift" "$base/Sources/LiveCommand.swift" "$base/Sources/LiveCatalog.swift" "$base/Sources/LiveOrdering.swift" "$base/Sources/LivePickup.swift" "$base/Sources/LiveCashier.swift" "$base/Sources/LiveCollection.swift" "$base/Sources/LiveKitchen.swift" "$base/Sources/LiveHistory.swift" "$base/Sources/HistoryExport.swift" "$base/Tests/DailyPaymentTests.swift" -o "$test_dir/daily-payment-tests"
"$test_dir/daily-payment-tests" "$base/../shared/fixtures"
