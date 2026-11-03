import type {MediaPurpose} from './media-asset-repository.js'
import {StaffAccessDeniedError,StaffAccessRepository} from './staff-access-repository.js'
import type {ScopedTransaction} from './transaction-runner.js'

export const MEDIA_READ_PERMISSIONS = ['community.activity.view','community.activity.manage','community.activity.publish',
  'customer.experience.feature.manage','media.asset.menu.manage'] as const

export function mediaUploadPermissions(purpose:MediaPurpose):readonly string[]{
  if(purpose==='support_contact')return ['community.activity.manage','customer.experience.feature.manage']
  return [purpose==='menu'?'media.asset.menu.manage':'community.activity.manage']
}

export async function assertMediaPermissions(
  transaction:ScopedTransaction,employeeId:string,permissions:readonly string[],
  access:Pick<StaffAccessRepository,'assertPermission'>=new StaffAccessRepository(transaction),
){
  let denied:unknown=new StaffAccessDeniedError('当前岗位没有图片素材权限')
  for(const permission of permissions){
    try{await access.assertPermission(employeeId,permission);return}
    catch(error){if(!(error instanceof StaffAccessDeniedError))throw error;denied=error}
  }
  throw denied
}
