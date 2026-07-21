import type { CapacitorConfig } from '@capacitor/cli'

const validationHost = 'mbox-ops-validation-845187646287.asia-east1.run.app'

const config: CapacitorConfig = {
  appId: 'com.superhigh.mbox.ops',
  appName: 'M-BOX 现场运营',
  webDir: 'dist',
  backgroundColor: '#111310',
  loggingBehavior: 'debug',
  server: {
    url: `https://${validationHost}`,
    cleartext: false,
    allowNavigation: [validationHost],
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
