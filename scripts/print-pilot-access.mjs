import { networkInterfaces } from 'node:os'

const addresses = Object.entries(networkInterfaces())
  .flatMap(([name, interfaces]) => (interfaces ?? []).map((network) => ({ name, ...network })))
  .filter((network) => network.family === 'IPv4' && !network.internal && /^(en|eth|wlan)/.test(network.name))

async function findWebPorts() {
  const candidates = Array.from({ length: 8 }, (_, index) => 5173 + index)
  const results = await Promise.all(candidates.map(async (port) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })
      const html = await response.text()
      return response.ok && html.includes('<title>M-Box 现场运营</title>') ? port : null
    } catch {
      return null
    }
  }))
  const activePorts = results.filter((port) => port !== null)
  return activePorts.length > 0 ? [Math.max(...activePorts)] : []
}

const webPorts = await findWebPorts()

if (addresses.length === 0) {
  console.error('未找到局域网IPv4地址，请先连接门店Wi-Fi。')
  process.exitCode = 1
} else {
  const ports = webPorts.length > 0 ? webPorts : [5173]
  console.log('M-Box局域网验证地址（设备必须连接同一Wi-Fi）：')
  for (const address of addresses) {
    for (const port of ports) {
      console.log(`- ${address.name}: http://${address.address}:${port}/`)
      console.log(`  顾客桌码样例: http://${address.address}:${port}/guest?table=L01`)
    }
  }
  if (webPorts.length === 0) console.log('当前未探测到运行中的Web服务，请先执行 npm run dev。')
  console.log('验证阶段不得录入真实支付密钥、身份证、人脸或完整手机号。')
}
