import type { StaffAuthView } from '../normalized-api'
import type { StaffBootstrapView } from '../shared/normalized-contracts'

export function staffWorkspaceIdentityKey(auth: StaffAuthView): string {
  return `${auth.session.id}:${auth.employee.id}`
}

export function bootstrapForAuthenticatedStaff(
  bootstrap: StaffBootstrapView | null,
  auth: StaffAuthView,
): StaffBootstrapView | null {
  return bootstrap?.staff.id === auth.employee.id ? bootstrap : null
}
