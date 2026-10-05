import type { StaffAuthView } from '../normalized-api'

// Compare the complete wire response, including scopes, approval limits and future
// authorization fields not yet represented by StaffAuthView. Only known lease /
// response metadata is omitted; a newly introduced field conservatively reloads.
function authorizationSnapshot(auth: StaffAuthView): unknown {
  const wire = { ...auth } as Record<string, unknown>
  delete wire.resolvedAt
  // Session lookup supplies these response annotations; heartbeat does not.
  delete wire.businessDate
  delete wire.timezone
  const session = { ...auth.session } as Record<string, unknown>
  delete session.onlineLeaseUntil
  return {
    ...wire,
    session,
    employee: { ...auth.employee, roleCodes: [...auth.employee.roleCodes].sort() },
    permissions: [...auth.permissions].sort(),
    deniedPermissions: [...auth.deniedPermissions].sort(),
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
  })
}

export function reconcileStaffAuth(previous: StaffAuthView | null, next: StaffAuthView): StaffAuthView {
  if (previous === null) return next
  const unchanged = canonicalJson(authorizationSnapshot(previous)) === canonicalJson(authorizationSnapshot(next))
  return {
    ...next,
    // Module loaders depend on permissions identity. Reuse only for equivalent
    // authorization, and invalidate even when scopes alone change. Keep fresh
    // lease / response metadata rather than retaining the old auth object.
    permissions: unchanged ? previous.permissions : [...next.permissions],
    deniedPermissions: unchanged ? previous.deniedPermissions : [...next.deniedPermissions],
  }
}
