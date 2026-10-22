import type {ActivityProductionCommand,ActivityProductionResult,ActivityServiceLine} from './activity-service.js'
export interface ActivityProductionBoard {
  activityItems:ActivityServiceLine[]
  commandScope?:string
  receipts?:ActivityProductionResult[]
  /** Stable only for the same employee and physical pickup device. Never a permission token. */
  recoveryNamespace?:string
  staffSessionId?:string
}
export interface ActivityProductionRecovery {
  staffSessionId:string
  commandScope:string
  idempotencyKey:string
  command:ActivityProductionCommand
}
