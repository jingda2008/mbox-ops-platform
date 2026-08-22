import { Camera, CheckCircle2, ScanLine, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type DetectorResult = { rawValue: string }
type DetectorInstance = { detect(source: HTMLVideoElement): Promise<DetectorResult[]> }
type DetectorConstructor = {
  new (options: { formats: string[] }): DetectorInstance
  getSupportedFormats?(): Promise<string[]>
}

const preferredFormats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code']
type CameraState = 'starting' | 'ready' | 'detected' | 'unavailable'

export function InventoryBarcodeScanner({ onClose, onDetected }: {
  onClose(): void
  onDetected(code: string): void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [cameraState, setCameraState] = useState<CameraState>('starting')
  const [detectedCode, setDetectedCode] = useState('')
  const [detail, setDetail] = useState('')

  useEffect(() => {
    let active = true
    let timer = 0
    let stream: MediaStream | null = null
    let stopFallback: (() => void) | null = null
    let accepted = false

    const stopCamera = () => {
      window.clearTimeout(timer)
      stopFallback?.()
      stopFallback = null
      stream?.getTracks().forEach((track) => track.stop())
    }
    const accept = (value: string) => {
      const code = value.trim()
      if (!active || code.length < 3 || code.length > 128) return false
      accepted = true
      setDetectedCode(code)
      setCameraState('detected')
      setDetail('')
      stopCamera()
      return true
    }
    const cameraFailure = (error: unknown) => {
      if (!active) return
      const name = error instanceof DOMException ? error.name : ''
      const message = name === 'NotAllowedError' || name === 'SecurityError'
        ? '请在浏览器设置中允许本页面使用摄像头，然后重新打开扫码。'
        : name === 'NotFoundError' || name === 'OverconstrainedError'
          ? '没有找到可用的后置摄像头。请改用其他设备或手工输入条码。'
          : name === 'NotReadableError' || name === 'AbortError'
            ? '摄像头可能正被其他应用占用。请关闭占用应用后重试。'
            : '当前浏览器无法调用摄像头，请手工输入条码。'
      setDetail(message)
      setCameraState('unavailable')
    }

    const startFallbackDecoder = async () => {
      if (!stream || !videoRef.current) return
      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser')
        const { BarcodeFormat, DecodeHintType } = await import('@zxing/library')
        if (!active || !stream || !videoRef.current) return
        const hints = new Map([[DecodeHintType.POSSIBLE_FORMATS, [
          BarcodeFormat.EAN_13,
          BarcodeFormat.EAN_8,
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
          BarcodeFormat.CODE_128,
          BarcodeFormat.QR_CODE,
        ]]])
        const reader = new BrowserMultiFormatReader(hints)
        const controls = await reader.decodeFromStream(stream, videoRef.current, (result) => {
          if (result !== undefined) accept(result.getText())
        })
        if (!active || accepted) controls.stop()
        else stopFallback = () => controls.stop()
        if (active) setDetail('已启用兼容识别，可扫描条形码或二维码。')
      } catch {
        // Keep the camera open for manual inspection; no camera frame leaves the device.
        if (active) setDetail('摄像头已打开，但当前设备的本地识别不可用；请手工输入条码。')
      }
    }

    const startNativeDetector = async (Detector: DetectorConstructor): Promise<boolean> => {
      try {
        const supported = Detector.getSupportedFormats ? await Detector.getSupportedFormats() : preferredFormats
        const formats = preferredFormats.filter((format) => supported.includes(format))
        // A QR-only native detector is not enough for liquor barcodes; use the local multi-format fallback.
        if (formats.length !== preferredFormats.length) return false
        const detector = new Detector({ formats })
        const detect = async () => {
          if (!active || !videoRef.current) return
          try {
            const results = await detector.detect(videoRef.current)
            if (results.some((result) => accept(result.rawValue))) return
          } catch {
            // Motion and focus can make a single frame unreadable; keep the camera open.
          }
          timer = window.setTimeout(detect, 220)
        }
        timer = window.setTimeout(detect, 220)
        return true
      } catch {
        return false
      }
    }

    const start = async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        cameraFailure(new DOMException('Camera API is unavailable', 'NotSupportedError'))
        return
      }
      try {
        // Ask for permission before deciding which local decoder can run.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        })
        if (!active || !videoRef.current) {
          stopCamera()
          return
        }
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        if (!active) return
        setCameraState('ready')
        const Detector = (window as Window & { BarcodeDetector?: DetectorConstructor }).BarcodeDetector
        if (Detector && await startNativeDetector(Detector)) {
          setDetail('将条形码或二维码放入框内。')
          return
        }
        await startFallbackDecoder()
      } catch (error) {
        cameraFailure(error)
      }
    }

    void start()
    return () => {
      active = false
      stopCamera()
    }
  }, [])

  return <div className="inventory-scanner-overlay" role="presentation">
    <section className="inventory-scanner-dialog" role="dialog" aria-modal="true" aria-labelledby="inventory-scanner-title">
      <header><div><small>手机摄像头</small><strong id="inventory-scanner-title">扫描酒瓶条形码或二维码</strong></div><button type="button" aria-label="关闭扫码" onClick={onClose}><X size={20} /></button></header>
      <div className={`inventory-camera is-${cameraState}`}>
        <video ref={videoRef} muted playsInline aria-label="库存扫码摄像头画面" />
        <i aria-hidden="true" />
        <span>{cameraState === 'detected' ? <><CheckCircle2 size={20} />识别成功</> : cameraState === 'unavailable' ? <><Camera size={20} />无法打开摄像头</> : <><ScanLine size={20} />{cameraState === 'ready' ? '将条码放入框内' : '正在打开后置摄像头'}</>}</span>
      </div>
      {detail !== '' && <p>{detail}</p>}
      {cameraState === 'detected' && <button className="inventory-scanner-accept" type="button" onClick={() => onDetected(detectedCode)}>使用识别结果</button>}
    </section>
  </div>
}
