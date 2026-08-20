import { Camera, CheckCircle2, ScanLine, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type DetectorResult = { rawValue: string }
type DetectorInstance = { detect(source: HTMLVideoElement): Promise<DetectorResult[]> }
type DetectorConstructor = {
  new (options: { formats: string[] }): DetectorInstance
  getSupportedFormats?(): Promise<string[]>
}

const preferredFormats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code']

export function InventoryBarcodeScanner({ onClose, onDetected }: {
  onClose(): void
  onDetected(code: string): void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [cameraState, setCameraState] = useState<'starting' | 'ready' | 'detected' | 'unavailable'>('starting')
  const [detectedCode, setDetectedCode] = useState('')

  useEffect(() => {
    let active = true
    let timer = 0
    let stream: MediaStream | null = null
    const Detector = (window as Window & { BarcodeDetector?: DetectorConstructor }).BarcodeDetector

    async function start() {
      if (!Detector || !navigator.mediaDevices?.getUserMedia) {
        setCameraState('unavailable')
        return
      }
      try {
        const supported = Detector.getSupportedFormats ? await Detector.getSupportedFormats() : preferredFormats
        const formats = preferredFormats.filter((format) => supported.includes(format))
        if (formats.length === 0) {
          setCameraState('unavailable')
          return
        }
        const detector = new Detector({ formats })
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        })
        if (!active || !videoRef.current) return
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        setCameraState('ready')
        const detect = async () => {
          if (!active || !videoRef.current) return
          try {
            const results = await detector.detect(videoRef.current)
            const code = results.map((result) => result.rawValue.trim()).find((value) => value.length >= 3 && value.length <= 128)
            if (code) {
              setDetectedCode(code)
              setCameraState('detected')
              stream?.getTracks().forEach((track) => track.stop())
              return
            }
          } catch {
            // Focusing and motion can make a single camera frame unreadable.
          }
          timer = window.setTimeout(detect, 220)
        }
        timer = window.setTimeout(detect, 220)
      } catch {
        if (active) setCameraState('unavailable')
      }
    }

    void start()
    return () => {
      active = false
      window.clearTimeout(timer)
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  return <div className="inventory-scanner-overlay" role="presentation">
    <section className="inventory-scanner-dialog" role="dialog" aria-modal="true" aria-labelledby="inventory-scanner-title">
      <header><div><small>手机摄像头</small><strong id="inventory-scanner-title">扫描酒瓶条形码或二维码</strong></div><button type="button" aria-label="关闭扫码" onClick={onClose}><X size={20} /></button></header>
      <div className={`inventory-camera is-${cameraState}`}>
        <video ref={videoRef} muted playsInline aria-label="库存扫码摄像头画面" />
        <i aria-hidden="true" />
        <span>{cameraState === 'detected' ? <><CheckCircle2 size={20} />识别成功</> : cameraState === 'unavailable' ? <><Camera size={20} />当前浏览器无法调用摄像头</> : <><ScanLine size={20} />{cameraState === 'ready' ? '将条码放入框内' : '正在打开后置摄像头'}</>}</span>
      </div>
      {cameraState === 'unavailable' && <p>请返回后手工输入条码；也可以改用支持摄像头识别的手机浏览器。</p>}
      {cameraState === 'detected' && <button className="inventory-scanner-accept" type="button" onClick={() => onDetected(detectedCode)}>使用识别结果</button>}
    </section>
  </div>
}
