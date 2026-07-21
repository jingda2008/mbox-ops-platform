import { describe, expect, it } from 'vitest'
import { selectVoiceRecognitionMode, shouldFallbackToCloudRecognition } from './voice-recording'

describe('voice recognition routing', () => {
  it('uses cloud recording first on Android even when native speech recognition is exposed', () => {
    expect(selectVoiceRecognitionMode({
      userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/122 Mobile Safari/537.36',
      nativeSupported: true,
      cloudSupported: true,
    })).toBe('cloud')
  })

  it('uses cloud recording first in the WeChat embedded browser', () => {
    expect(selectVoiceRecognitionMode({
      userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.49',
      nativeSupported: true,
      cloudSupported: true,
    })).toBe('cloud')
  })

  it('keeps native recognition on a desktop browser when it is available', () => {
    expect(selectVoiceRecognitionMode({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/122 Safari/537.36',
      nativeSupported: true,
      cloudSupported: true,
    })).toBe('native')
  })

  it('automatically falls back after a native service failure but not after a user stop', () => {
    expect(shouldFallbackToCloudRecognition('network', true, false)).toBe(true)
    expect(shouldFallbackToCloudRecognition('service-not-allowed', true, false)).toBe(true)
    expect(shouldFallbackToCloudRecognition('network', true, true)).toBe(false)
    expect(shouldFallbackToCloudRecognition('not-allowed', true, false)).toBe(false)
  })
})
