import type { Area } from './contracts.js'

export interface VenueTableDefinition {
  id: string
  code: string
  displayName: string
  areaId: string
  capacity: number
  assignmentGroup: 'vip' | 'lounge' | 'main-a' | 'main-b' | 'main-c' | 'stage-side' | 'special' | 'outside'
}

export const MBOX_VENUE_LAYOUT_VERSION = 1
export const MBOX_LEGACY_AREA_ID = 'interactive'

export const mboxVenueAreas: Area[] = [
  { id: 'booth', name: 'VIP卡座区', shortName: 'VIP', color: '#8a6944', sortOrder: 1 },
  { id: 'lounge', name: '近吧台L区', shortName: 'L区', color: '#ad874f', sortOrder: 2 },
  { id: 'main-a', name: '大厅A区', shortName: 'A区', color: '#617b71', sortOrder: 3 },
  { id: 'main-b', name: '大厅B区', shortName: 'B区', color: '#526b7c', sortOrder: 4 },
  { id: 'main-c', name: '大厅C区', shortName: 'C区', color: '#766c86', sortOrder: 5 },
  { id: 'social', name: '舞台侧S区', shortName: 'S区', color: '#a85d58', sortOrder: 6 },
  { id: 'special', name: '多人桌区', shortName: '多人桌', color: '#9a7d3f', sortOrder: 7 },
  { id: 'walkin', name: '室外W区', shortName: '室外', color: '#4f7961', sortOrder: 8 },
  { id: MBOX_LEGACY_AREA_ID, name: '旧互动桌（过渡）', shortName: '过渡', color: '#8b8f89', sortOrder: 99 },
]

function numberedTables(
  prefix: string,
  count: number,
  areaId: string,
  assignmentGroup: VenueTableDefinition['assignmentGroup'],
  capacity: number | ((index: number) => number),
) {
  return Array.from({ length: count }, (_, offset): VenueTableDefinition => {
    const index = offset + 1
    const padded = String(index).padStart(2, '0')
    const tableCapacity = typeof capacity === 'function' ? capacity(index) : capacity
    return {
      id: `table-${prefix.toLowerCase()}${padded}`,
      code: `${prefix}${padded}`,
      displayName: `${prefix}${index}桌`,
      areaId,
      capacity: tableCapacity,
      assignmentGroup,
    }
  })
}

export const mboxVenueTables: VenueTableDefinition[] = [
  { id: 'table-vip1', code: 'VIP1', displayName: 'VIP1卡座', areaId: 'booth', capacity: 6, assignmentGroup: 'vip' },
  { id: 'table-vip2', code: 'VIP2', displayName: 'VIP2卡座', areaId: 'booth', capacity: 6, assignmentGroup: 'vip' },
  { id: 'table-vip3', code: 'VIP3', displayName: 'VIP3卡座', areaId: 'booth', capacity: 8, assignmentGroup: 'vip' },
  { id: 'table-vip4', code: 'VIP4', displayName: 'VIP4卡座', areaId: 'booth', capacity: 6, assignmentGroup: 'vip' },
  { id: 'table-vip5', code: 'VIP5', displayName: 'VIP5卡座', areaId: 'booth', capacity: 4, assignmentGroup: 'vip' },
  { id: 'table-666', code: '666', displayName: '666多人桌', areaId: 'special', capacity: 6, assignmentGroup: 'special' },
  { id: 'table-888', code: '888', displayName: '888多人桌', areaId: 'special', capacity: 6, assignmentGroup: 'special' },
  ...numberedTables('L', 7, 'lounge', 'lounge', 2),
  ...numberedTables('A', 8, 'main-a', 'main-a', 2),
  ...numberedTables('B', 8, 'main-b', 'main-b', 2),
  ...numberedTables('C', 7, 'main-c', 'main-c', 2),
  ...numberedTables('S', 7, 'social', 'stage-side', 2),
  ...numberedTables('W', 17, 'walkin', 'outside', (index) => {
    if (index === 8) return 6
    if (index >= 10) return 4
    return 2
  }),
]

export const mboxVenueTableIds = new Set(mboxVenueTables.map((table) => table.id))
export const mboxVenueTableCodes = new Set(mboxVenueTables.map((table) => table.code))
