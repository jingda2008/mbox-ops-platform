export type IncidentResolution = 'paper_confirmed' | 'not_printed' | 'device_restored'
export interface PrintIncident {
  id: string; episodeStartedAt: string; bridgeId: string; jobId: string | null; kind: string; failureCode: string | null
  status: 'open' | 'claimed' | 'resolved'; firstSeenAt: string; lastSeenAt: string; occurrences: number
  claimedBy: string | null; resolution: IncidentResolution | null
  escalation: 'staff' | 'supervisor' | 'administrator'
}

export function incidentPermissions(permissions: readonly string[]) {
  const manage = permissions.includes('printer.manage') || permissions.includes('hardware.manage')
  return { view: manage || permissions.includes('print.retry') || permissions.includes('print.reprint'),
    claim: manage || permissions.includes('print.reprint'),
    resolve: manage || permissions.includes('print.reprint') }
}
export function incidentCanResolve(row: PrintIncident, employeeId: string, permissions: readonly string[]) {
  return row.status === 'claimed' && row.claimedBy === employeeId && incidentPermissions(permissions).resolve
}

