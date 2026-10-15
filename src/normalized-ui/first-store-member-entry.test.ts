import {createElement} from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {it,expect} from 'vitest'
import {CustomerExperienceManagementPanel} from './CustomerExperienceManagementPanel'
import {ConfirmationDialogProvider} from './ConfirmationDialog'
import {NormalizedApiClient,type StaffAuthView} from '../normalized-api'
function render(permissions:string[]){const auth={employee:{id:'employee'},session:{id:'session'},permissions} as StaffAuthView;return renderToStaticMarkup(createElement(ConfirmationDialogProvider,{children:createElement(CustomerExperienceManagementPanel,{api:new NormalizedApiClient(),auth,dashboard:null,mode:'member-exceptions'})}))}
it('provides order supplement and manual review entry to authorized staff without reporting unloaded balances as no exceptions',()=>{
 const html=render(['loyalty.accrual.exception.view','loyalty.accrual.request','loyalty.adjust.manual','loyalty.accrual.approve'])
 expect(html).toContain('积分对账与漏发');expect(html).toContain('人工积分申请与审核');expect(html).toContain('积分数据尚未确认');expect(html).not.toContain('当前没有待补发差异')
})
it('does not expose manual adjustment controls to employees without that permission',()=>{expect(render(['loyalty.accrual.exception.view'])).not.toContain('人工积分申请与审核')})
