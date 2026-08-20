# M-BOX 1.0.0-rc.93

## Scope

This candidate updates the normalized staff service, staff web application and
customer mini-program assets. It includes the protected Alibaba Cloud RDS
recovery and reservation business-day corrections already released in
`1.0.0-rc.92`.

## Catalogue and inventory workflow

- Adds 56 first-party menu images and matching inactive product drafts for
  snacks, signature drinks, classic cocktails and packages.
- Keeps every new draft hidden from guests and leaves cost empty until purchase
  invoices, recipe yield, current stock and physical output are verified by the
  responsible staff. The release does not infer cost from sale price or activate
  unverified products.
- Adds an authorized recipe editor and readback for tracked products. Recipes
  remain strongly typed inventory records rather than free-form product data.
- Keeps snacks and fruit explicitly eligible for the non-managed inventory mode
  when the store chooses not to track their quantities.

## Customer experience

- Refines the mini-program home, menu entry, member invitation, navigation and
  narrow-screen ordering layout.
- Preserves customer choice: browsing and ordering continue after refusal, and
  WeChat phone authorization is available only after the customer actively
  selects the agreement control.
- After the final arrival slot has passed, opens public booking on the next
  bookable business date instead of presenting an unusable current-date form.
- Lets authorized staff confirm future pending reservations in advance while
  keeping future confirmed reservations out of the current-day arrival queue.

## Acceptance boundary

The included catalogue records are drafts, not approved live merchandise.
Production activation still requires real cost, recipe, stock and physical
output review. WeChat platform upload/review, real-device authorization, real
payment and refund, simulated inventory evidence and role-by-role store
acceptance remain separate release and operating evidence.
