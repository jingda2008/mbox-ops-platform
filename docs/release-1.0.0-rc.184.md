# M-BOX 1.0.0-rc.184

Consolidated September 9–10 development candidate, including normalized migrations 163–186. Supersedes the rc.183 source checkpoint without replacing its immutable tag or artifacts.

Scope includes member cards and consent controls, coupon/checkout-upgrade chains, linked WeChat/Alipay layouts, payment-independent operating recovery, asynchronous bar/kitchen print jobs and policies, unpaid pre-bills, offline refund recording, admission stop controls preserving existing registrations, operating history/export and scoped employee order drafts.

The current operating policy prohibits manual early business-day ending: the removed UI and retired endpoints cannot advance the current day. Scheduled rollover remains, and unpaid/refund/fulfillment facts are not silently completed. Legacy structures and immutable order dates remain for compatibility.

Local automated evidence and PR CI are distinct from production, physical-printer and real-device acceptance. GROW-01–05 remaining development, unavailable SMS configuration, real payment/refund reconciliation, physical output and native field acceptance remain open. Generated acceptance registers must preserve those gaps. No real marketing, refund or device acceptance is implied by this release.

Deployment must use the exact main-reachable SHA and immutable image, configuration and migration checks, verified backup, isolated candidate verification and read-back after cutover. WeChat upload/experience selection are separately verified; do not upload a candidate against an incompatible backend. No Alipay upload or standalone Android application is authorized by this release.
