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

  useEffect(() => {
    let active = true
    let timer = 0
    let stream: MediaStream | null = null
    const BarcodeDetectorConstructor = (window as Window & {
      BarcodeDetector?: new (options: { formats: string[] }) => {
        detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>
      }
    }).BarcodeDetector

    async function startCamera() {
      if (!BarcodeDetectorConstructor || !navigator.mediaDevices?.getUserMedia) {
        setCameraState('unavailable')
        return
      }
      try {
        const detector = new BarcodeDetectorConstructor({ formats: ['code_128', 'qr_code'] })
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' } },
        })
        if (!active || !videoRef.current) return
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        setCameraState('ready')
        const detect = async () => {
          if (!active || !videoRef.current) return
          try {
            const result = await detector.detect(videoRef.current)
            const value = result.map((item) => item.rawValue.trim()).find((item) => CUSTOMER_PAYMENT_CODE.test(item))
            if (value) {
              setCode(value)
              setCameraState('detected')
              stream?.getTracks().forEach((track) => track.stop())
              return
            }
          } catch {
            // A transient frame read can fail while the camera is focusing.
          }
          timer = window.setTimeout(detect, 220)
        }
        timer = window.setTimeout(detect, 220)
      } catch {
        if (active) setCameraState('unavailable')
      }
    }
    void startCamera()
    return () => {
      active = false
      window.clearTimeout(timer)
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const normalized = code.trim()
    if (!CUSTOMER_PAYMENT_CODE.test(normalized)) {
      setError('请重新扫描有效的微信、支付宝或云闪付付款码')
      return
    }
    setError('')
    setSubmitting(true)
    try {
      const accepted = await onConfirm(normalized)
      if (accepted !== false) setCode('')
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '付款码收款发起失败')
    } finally {
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
