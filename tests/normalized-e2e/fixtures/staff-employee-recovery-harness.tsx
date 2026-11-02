import React from 'react'
import { createRoot } from 'react-dom/client'
import { NormalizedApiClient } from '../../../src/normalized-api'
import { ConfirmationDialogProvider } from '../../../src/normalized-ui/ConfirmationDialog'
import { StaffAccessManagementPanel } from '../../../src/normalized-ui/StaffAccessManagementPanel'
const root = createRoot(document.getElementById('root')!)
const api = new NormalizedApiClient()
const render = (actor = '11111111-1111-4111-8111-111111111111') => root.render(<ConfirmationDialogProvider><StaffAccessManagementPanel api={api} currentEmployeeId={actor} /></ConfirmationDialogProvider>)
Object.assign(window, { employeeHarness: { render } })
render()
