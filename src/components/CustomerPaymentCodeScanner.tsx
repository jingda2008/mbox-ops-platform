import { CheckCircle2, CircleAlert, ScanLine, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import './CustomerPaymentCodeScanner.css'

export const CUSTOMER_PAYMENT_CODE = /^(?:1[0-5]\d{16}|(?:2[5-9]|30)\d{14,22}|62\d{17})$/

export function CustomerPaymentCodeScanner({ tableCode, amountLabel, onClose, onConfirm }: {
  tableCode: string
  amountLabel: string
  onClose: () => void
  onConfirm: (customerAuthCode: string) => boolean | void | Promise<boolean | void>
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [code, setCode] = useState('')
  const [cameraState, setCameraState] = useState<'starting' | 'ready' | 'detected' | 'unavailable'>('starting')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [cameraDetail, setCameraDetail] = useState('')

  useEffect(() => {
    let active = true
    let timer = 0
    let stream: MediaStream | null = null
    let stopFallback: (() => void) | null = null
    let accepted = false
    const BarcodeDetectorConstructor = (window as Window & {
      BarcodeDetector?: {
        new (options: { formats: string[] }): {
          detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>
        }
        getSupportedFormats?: () => Promise<string[]>
      }
    }).BarcodeDetector

    const stopCamera = () => {
      window.clearTimeout(timer)
      stopFallback?.()
      stopFallback = null
      stream?.getTracks().forEach((track) => track.stop())
    }
    const accept = (raw: string) => {
      const value = raw.trim()
      if (!active || accepted || !CUSTOMER_PAYMENT_CODE.test(value)) return false
      accepted = true
      setCode(value)
      setCameraState('detected')
      setCameraDetail('请核对本次收款金额，再确认发起收款。')
      stopCamera()
      return true
    }
    const startFallback = async () => {
      const { BrowserMultiFormatReader } = await import('@zxing/browser')
      const { BarcodeFormat, DecodeHintType } = await import('@zxing/library')
      if (!active || accepted || !stream || !videoRef.current) return
      const reader = new BrowserMultiFormatReader(new Map([
        [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE]],
      ]))
      // Frames stay on this device. Reading a code never initiates a payment.
      const controls = await reader.decodeFromStream(stream, videoRef.current, (result) => {
        if (result) accept(result.getText())
      })
      if (!active || accepted) controls.stop()
      else {
        stopFallback = () => controls.stop()
        setCameraDetail('已启用兼容识码；请出示顾客付款码，不是个人收款二维码。')
      }
    }
    const unavailable = (reason: unknown) => {
      stopCamera()
      if (!active) return
      const name = reason instanceof Error ? reason.name : ''
      setCameraState('unavailable')
      setCameraDetail(name === 'NotAllowedError' || name === 'SecurityError'
        ? '摄像头未获授权，请允许后重新打开；也可使用扫码枪或改用其他收款方式。'
        : name === 'NotReadableError'
          ? '摄像头可能被其他应用占用；请关闭占用应用后重试，或使用扫码枪。'
          : '当前设备无法启动识码；请使用扫码枪、输入顾客付款码或改用其他收款方式。')
    }

    async function startCamera() {
      if (!navigator.mediaDevices?.getUserMedia) {
        unavailable(null)
        return
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' } },
        })
        if (!active || !videoRef.current) { stopCamera(); return }
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        if (!active) { stopCamera(); return }
        setCameraState('ready')
        let detector: { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> } | null = null
        if (BarcodeDetectorConstructor) {
          try {
            const supported = BarcodeDetectorConstructor.getSupportedFormats
              ? await BarcodeDetectorConstructor.getSupportedFormats() : ['code_128', 'qr_code']
            if (['code_128', 'qr_code'].every((format) => supported.includes(format))) {
              detector = new BarcodeDetectorConstructor({ formats: ['code_128', 'qr_code'] })
            }
          } catch { /* Fall back when a native detector exists but cannot initialize. */ }
        }
        if (!active) { stopCamera(); return }
        if (!detector) { await startFallback(); return }
        let failures = 0
        const detect = async () => {
          if (!active || !videoRef.current) return
          try {
            const result = await detector.detect(videoRef.current)
            if (result.some((item) => accept(item.rawValue))) return
            failures = 0
          } catch {
            if (++failures >= 3) {
              try { await startFallback() } catch (reason) { unavailable(reason) }
              return
            }
          }
          if (active) timer = window.setTimeout(detect, 220)
        }
        timer = window.setTimeout(detect, 220)
      } catch (reason) {
        unavailable(reason)
      }
    }
    void startCamera()
    return () => {
      active = false
      stopCamera()
    }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submittingRef.current) return
    const normalized = code.trim()
    if (!CUSTOMER_PAYMENT_CODE.test(normalized)) {
      setError('请重新扫描有效的微信、支付宝或云闪付付款码')
      return
    }
    setError('')
    submittingRef.current = true
    setSubmitting(true)
    try {
      const accepted = await onConfirm(normalized)
      if (accepted !== false) setCode('')
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '付款码收款发起失败')
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className="payment-scanner-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form className="payment-scanner-dialog" role="dialog" aria-modal="true" aria-labelledby="payment-scanner-context payment-scanner-title" onSubmit={submit}>
        <header>
          <div><span id="payment-scanner-context">{tableCode} · 本次收款</span><strong id="payment-scanner-title">{amountLabel}</strong></div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>×</button>
        </header>
        <div className={`payment-camera is-${cameraState}`}>
          <video ref={videoRef} muted playsInline aria-label="付款码摄像头画面" />
          <span>{cameraState === 'detected' ? <><CheckCircle2 size={20} />付款码已读取</> : cameraState === 'unavailable' ? <><ScanLine size={20} />请使用扫码枪或输入付款码</> : <><ScanLine size={20} />{cameraState === 'ready' ? '对准客户付款码' : '正在启动摄像头'}</>}</span>
        </div>
        {cameraDetail && <p role="status">{cameraDetail}</p>}
        <label className="payment-code-field">
          <span>客户付款码</span>
          <input
            autoComplete="off"
            autoFocus={cameraState === 'unavailable'}
            inputMode="numeric"
            maxLength={35}
            placeholder="扫码枪读取或手工输入"
            type="password"
            value={code}
            onChange={(event) => { setCode(event.target.value.replace(/\s/g, '')); setError('') }}
          />
          <small>{code ? `已读取 ${code.length} 位` : '微信 / 支付宝 / 云闪付'}</small>
        </label>
        {error && <div className="payment-code-error" role="alert"><CircleAlert size={15} />{error}</div>}
        <button className="primary-button" type="submit" disabled={!code || submitting}><ShieldCheck size={17} />{submitting ? '正在发起收款' : '确认发起收款'}</button>
      </form>
    </div>
  )
}
