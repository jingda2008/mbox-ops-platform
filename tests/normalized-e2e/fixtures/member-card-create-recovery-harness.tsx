import React from 'react'
import {createRoot} from 'react-dom/client'
import {NormalizedApiClient,type StaffAuthView} from '../../../src/normalized-api'
import {ConfirmationDialogProvider} from '../../../src/normalized-ui/ConfirmationDialog'
import {MemberCardManagementPanel} from '../../../src/normalized-ui/MemberCardManagementPanel'
const api=new NormalizedApiClient()
const auth={employee:{id:'11111111-1111-4111-8111-111111111111'},permissions:['member.card.manage','loyalty.policy.publish']} as StaffAuthView
createRoot(document.getElementById('root')!).render(<ConfirmationDialogProvider><MemberCardManagementPanel api={api} auth={auth}/></ConfirmationDialogProvider>)
