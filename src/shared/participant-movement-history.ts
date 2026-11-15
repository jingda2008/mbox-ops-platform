export interface ParticipantMovementHistory {
  items:Array<{
    id:string
    kind:'whole_table_transfer'|'participant_split'|'participant_merge'
    sourceTableCode:string
    targetTableCode:string
    movedGuestCount:number
    employeeName:string
    occurredAt:string
    targetCurrentTableCode:string
    targetSessionStatus:'open'|'closing'|'closed'
  }>
  nextCursor:string|null
}
