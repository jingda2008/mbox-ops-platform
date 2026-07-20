import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outputDir = resolve(root, 'public/downloads')
const iconPath = resolve(root, 'public/icons/apple-touch-icon-180.png')
const profilePath = resolve(outputDir, 'MBOX-Ops-Validation.mobileconfig')
const checksumPath = `${profilePath}.sha256`
const installUrl = 'https://mbox-ops-validation-845187646287.asia-east1.run.app/'

await mkdir(outputDir, { recursive: true })
const icon = await readFile(iconPath)
const iconData = icon.toString('base64')

const profile = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>FullScreen</key>
      <true/>
      <key>Icon</key>
      <data>${iconData}</data>
      <key>IsRemovable</key>
      <true/>
      <key>Label</key>
      <string>M-BOX运营</string>
      <key>PayloadDescription</key>
      <string>在主屏幕安装 M-BOX 现场运营验证入口。</string>
      <key>PayloadDisplayName</key>
      <string>M-BOX 现场运营</string>
      <key>PayloadIdentifier</key>
      <string>com.superhigh.mbox.ops.webclip</string>
      <key>PayloadType</key>
      <string>com.apple.webClip.managed</string>
      <key>PayloadUUID</key>
      <string>5D042E18-8AD2-45F1-A4AC-C4E5013B939A</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>Precomposed</key>
      <true/>
      <key>URL</key>
      <string>${installUrl}</string>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>M-BOX 员工端 iPhone 验证入口，可随时移除。</string>
  <key>PayloadDisplayName</key>
  <string>M-BOX 运营验证版</string>
  <key>PayloadIdentifier</key>
  <string>com.superhigh.mbox.ops.validation</string>
  <key>PayloadOrganization</key>
  <string>SUPERHIGH · M-BOX</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>B0C17011-C7DF-471B-A450-9636AE608F97</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`

await writeFile(profilePath, profile)
const checksum = createHash('sha256').update(profile).digest('hex')
await writeFile(checksumPath, `${checksum}  MBOX-Ops-Validation.mobileconfig\n`)

console.log(`Generated ${profilePath}`)
console.log(`SHA-256 ${checksum}`)
