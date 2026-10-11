/** The release-owned external-channel configuration. Database events, PrintBridge,
 * dedicated WeChat delivery and payments have independent in-process services.
 * No generic destination is configured: retain its queue instead of fake delivery.
 * An enabled external adapter must implement protocol 2 and return provider receipts.
 */
export async function createNormalizedWorkerAdapters() {
  const capabilities=Object.freeze([])
  const unavailable=async()=>{throw new Error('external_channel_not_configured')}
  return Object.freeze({
    protocolVersion:2,capabilities,
    preflight:async()=>({protocolVersion:2,capabilities}),
    outbox:unavailable,notification:unavailable,
    print:Object.freeze({print:unavailable}),sop:Object.freeze({execute:unavailable}),
  })
}
