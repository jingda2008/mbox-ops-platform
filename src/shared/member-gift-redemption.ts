import type { MenuBundleChoiceGroup, MenuBundleUnitSelection } from './contracts.js'

export interface MemberGiftWallet {
  employeeId: string; customerId: string; memberNo: string; permissions: string[]
  tables: Array<{id:string;code:string}>; nextCursor: string|null
  items: Array<{
    id:string;title:string;type:string;state:string;quantityAvailable:number;version:number
    snackClaim:boolean;pricePromise:unknown|null
    products:Array<{id:string;name:string;status:string;bundleChoiceGroups?:MenuBundleChoiceGroup[]}>
    reservations:Array<{id:string;tableSessionId:string;quantity:number;tableCode:string;canRedeem:boolean;expiresAt:string}>
  }>
}
export type MemberGiftCommand = {action:'reserve';body:{customerId:string;benefitId:string;tableSessionId:string;quantity:number;expectedVersion:number}}
  | {action:'redeem';body:{customerId:string;benefitId:string;tableSessionId:string;reservationId:string;quantity:number;selectedProductId:string;bundleSelections?:MenuBundleUnitSelection[]}}
  | {action:'cancel';body:{customerId:string;benefitId:string;tableSessionId:string;reservationId:string;quantity:number;reason:string}}
export interface MemberGiftReceipt {employeeId:string;customerId:string;requestKey:string;action:MemberGiftCommand['action'];result:{id:string}}
