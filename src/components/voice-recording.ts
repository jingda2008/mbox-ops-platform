export type VoiceRecognitionMode = 'native' | 'cloud' | 'unavailable'

interface VoiceRecognitionModeInput {
  userAgent: string
  nativeSupported: boolean
  cloudSupported: boolean
  forceCloud?: boolean
  forceNative?: boolean
}

const CLOUD_FIRST_USER_AGENT = /Android|MicroMessenger|\bwv\b|MQQBrowser/i

export function selectVoiceRecognitionMode({
  userAgent,
  nativeSupported,
  cloudSupported,
  forceCloud = false,
  forceNative = false,
}: VoiceRecognitionModeInput): VoiceRecognitionMode {
  if (forceNative && nativeSupported) return 'native'
  if (cloudSupported && (forceCloud || !nativeSupported || CLOUD_FIRST_USER_AGENT.test(userAgent))) return 'cloud'
  if (nativeSupported) return 'native'
  if (cloudSupported) return 'cloud'
  return 'unavailable'
}

export function shouldFallbackToCloudRecognition(
  error: string,
  cloudSupported: boolean,
  stopRequested: boolean,
) {
  if (!cloudSupported || stopRequested) return false
  return ['network', 'service-not-allowed'].includes(error)
}
