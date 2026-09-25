// Explicit aliases for the approved 2026-09-25 roster, shared by read filters
// and printed QR hints. QR tokens remain independently authenticated by the server.
export const approvedTableCodeAliases: Readonly<Record<string, string>> = {
  "W01": "W1",
  "W02": "W2",
  "W03": "W3",
  "W05": "W5",
  "W06": "W6",
  "W07": "W7",
  "W08": "W8",
  "W09": "W9",
  "C01": "C1",
  "C02": "C2",
  "C03": "C3",
  "C05": "C5",
  "C06": "C6",
  "C07": "C7",
  "B01": "B1",
  "B02": "B2",
  "B03": "B3",
  "B05": "B5",
  "B06": "B6",
  "B07": "B7",
  "B08": "B8",
  "A01": "A1",
  "A02": "A2",
  "A03": "A3",
  "A05": "A5",
  "A06": "A6",
  "A07": "A7",
  "A08": "A8"
}

export function canonicalTableCode(value: string): string {
    const code = value.toUpperCase()
    return Object.prototype.hasOwnProperty.call(approvedTableCodeAliases, code) ? approvedTableCodeAliases[code]! : code
}

export function sameGuestTableCode(actual: string, hint: string): boolean {
  return canonicalTableCode(actual) === canonicalTableCode(hint)
}
