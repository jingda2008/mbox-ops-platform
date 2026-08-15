import type { CapacitorConfig } from '@capacitor/cli'

const validationHost = 'mbox-ops-validation-845187646287.asia-east1.run.app'
const defaultValidationUrl = `https://${validationHost}`
const mobileValidationUrl = process.env.MBOX_MOBILE_VALIDATION === '1'
  ? process.env.MBOX_MOBILE_VALIDATION_URL?.trim()
  : undefined
const serverUrl = mobileValidationUrl === undefined || mobileValidationUrl === ''
  ? defaultValidationUrl
  : mobileValidationUrl
const serverHost = new URL(serverUrl).hostname

const config: CapacitorConfig = {
  appId: 'com.superhigh.mbox.ops',
  appName: 'M-BOX 现场运营',
  webDir: 'dist',
  backgroundColor: '#111310',
  loggingBehavior: 'debug',
  server: {
    url: serverUrl,
    cleartext: serverUrl.startsWith('http://'),
    allowNavigation: [serverHost],
  },
  ios: {
    scheme: 'MBOXOps',
    backgroundColor: '#111310',
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    scrollEnabled: true,
    allowsLinkPreview: false,
  },
}

export default config
