import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import './confirmation-dialog.css'

export type ConfirmationTone = 'default' | 'danger'

export type ConfirmationRequest = Readonly<{
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  tone?: ConfirmationTone
}>

export type InputPromptRequest = Readonly<{
  title: string
  description: string
  label?: string
  defaultValue?: string
  confirmLabel?: string
  cancelLabel?: string
  multiline?: boolean
}>

type PendingConfirmation = Readonly<{
  request: ConfirmationRequest
  resolve: (confirmed: boolean) => void
}>

type ConfirmationContextValue = Readonly<{
  confirmAction: (request: ConfirmationRequest) => Promise<boolean>
  promptAction: (request: InputPromptRequest) => Promise<string | null>
}>

const ConfirmationContext = createContext<ConfirmationContextValue | null>(null)

function normalizeRequest(request: ConfirmationRequest): ConfirmationRequest {
  return {
    title: request.title.trim() || '请确认操作',
    description: request.description.trim(),
    confirmLabel: request.confirmLabel?.trim() || '确认',
    cancelLabel: request.cancelLabel?.trim() || '返回',
    tone: request.tone === 'danger' ? 'danger' : 'default',
  }
}

function normalizeInputPrompt(request: InputPromptRequest): InputPromptRequest {
  return {
    title: request.title.trim() || '请填写信息',
    description: request.description.trim(),
    label: request.label?.trim() || '填写内容',
    defaultValue: request.defaultValue ?? '',
    confirmLabel: request.confirmLabel?.trim() || '继续',
    cancelLabel: request.cancelLabel?.trim() || '返回',
    multiline: request.multiline !== false,
  }
}

function ConfirmationDialog({
  pending,
  onResolve,
}: Readonly<{
  pending: PendingConfirmation | null
  onResolve: (confirmed: boolean) => void
}>) {
  const titleId = useId()
  const descriptionId = useId()
  const cancelButton = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (pending === null) return
    cancelButton.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onResolve(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onResolve, pending])

  if (pending === null) return null
  const request = pending.request
  return (
    <div className="normalized-confirmation-mask" role="presentation" onMouseDown={() => onResolve(false)}>
      <section
        className="normalized-confirmation-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <strong id={titleId}>{request.title}</strong>
        </header>
        <p id={descriptionId}>{request.description}</p>
        <footer>
          <button ref={cancelButton} type="button" className="normalized-confirmation-cancel" onClick={() => onResolve(false)}>
            {request.cancelLabel}
          </button>
          <button type="button" className={request.tone === 'danger' ? 'normalized-confirmation-danger' : 'normalized-confirmation-primary'} onClick={() => onResolve(true)}>
            {request.confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  )
}

function InputPromptDialog({
  pending,
  onResolve,
}: Readonly<{
  pending: Readonly<{ request: InputPromptRequest; resolve: (value: string | null) => void }> | null
  onResolve: (value: string | null) => void
}>) {
  const titleId = useId()
  const descriptionId = useId()
  const inputId = useId()
  const input = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const [value, setValue] = useState('')

  useEffect(() => {
    if (pending === null) return
    setValue(pending.request.defaultValue ?? '')
    window.setTimeout(() => input.current?.focus(), 0)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onResolve(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onResolve, pending])

  if (pending === null) return null
  const request = pending.request
  return (
    <div className="normalized-confirmation-mask" role="presentation" onMouseDown={() => onResolve(null)}>
      <section
        className="normalized-confirmation-dialog normalized-input-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={request.description ? descriptionId : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header><strong id={titleId}>{request.title}</strong></header>
        {request.description && <p id={descriptionId}>{request.description}</p>}
        <label htmlFor={inputId}>
          <span>{request.label}</span>
          {request.multiline
            ? <textarea id={inputId} ref={(node) => { input.current = node }} value={value} onChange={(event) => setValue(event.target.value)} />
            : <input id={inputId} ref={(node) => { input.current = node }} value={value} onChange={(event) => setValue(event.target.value)} />}
        </label>
        <footer>
          <button type="button" className="normalized-confirmation-cancel" onClick={() => onResolve(null)}>{request.cancelLabel}</button>
          <button type="button" className="normalized-confirmation-primary" onClick={() => onResolve(value)}>{request.confirmLabel}</button>
        </footer>
      </section>
    </div>
  )
}

export function ConfirmationDialogProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [pending, setPending] = useState<PendingConfirmation | null>(null)
  const [pendingPrompt, setPendingPrompt] = useState<Readonly<{ request: InputPromptRequest; resolve: (value: string | null) => void }> | null>(null)

  const resolve = useCallback((confirmed: boolean) => {
    setPending((current) => {
      current?.resolve(confirmed)
      return null
    })
  }, [])

  const confirmAction = useCallback((request: ConfirmationRequest) => new Promise<boolean>((resolveRequest) => {
    setPending({ request: normalizeRequest(request), resolve: resolveRequest })
  }), [])

  const resolvePrompt = useCallback((value: string | null) => {
    setPendingPrompt((current) => {
      current?.resolve(value)
      return null
    })
  }, [])

  const promptAction = useCallback((request: InputPromptRequest) => new Promise<string | null>((resolveRequest) => {
    setPendingPrompt({ request: normalizeInputPrompt(request), resolve: resolveRequest })
  }), [])

  const value = useMemo(() => ({ confirmAction, promptAction }), [confirmAction, promptAction])
  return (
    <ConfirmationContext.Provider value={value}>
      {children}
      <ConfirmationDialog pending={pending} onResolve={resolve} />
      <InputPromptDialog pending={pendingPrompt} onResolve={resolvePrompt} />
    </ConfirmationContext.Provider>
  )
}

export function useConfirmationDialog() {
  const value = useContext(ConfirmationContext)
  if (value === null) {
    throw new Error('useConfirmationDialog 必须在 ConfirmationDialogProvider 内使用')
  }
  return value
}
