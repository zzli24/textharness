// electron-builder afterPack 钩子：在没有 Apple 开发者证书时做「ad-hoc 签名」。
//
// 为什么需要它：
//   identity: null 会让 electron-builder 完全跳过签名，产出的 .app 没有任何签名的痕迹。
//   macOS 上从网络下载的包会带 com.apple.quarantine，Gatekeeper 对「已隔离 + 无签名」
//   的 App 直接报「已损坏，应移到废纸篓」——用户会以为文件坏了。
//   ad-hoc 签名（codesign --sign -）不改分发方式，但能让系统识别成"未签名的开发者"，
//   提示变成可以绕过的「无法验证开发者」，右键打开或 xattr 即可运行。
//
// 有正式证书时（CSC_LINK / CSC_NAME 已配置）electron-builder 会自己签名，
// 这里自动跳过，避免破坏真实签名。

const { execFileSync } = require('node:child_process')

const AD_HOC = '-'

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  // 有真实证书时不要插手
  if (process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_KEY_PASSWORD) {
    console.log('[after-pack] 检测到正式证书，跳过 ad-hoc 签名')
    return
  }

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = `${context.appOutDir}/${appName}`

  console.log(`[after-pack] ad-hoc 签名 ${appPath}`)
  try {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', AD_HOC, '--timestamp=none', appPath],
      { stdio: 'inherit' }
    )
    const info = execFileSync('codesign', ['-dv', appPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    console.log(info.trim())
  } catch (err) {
    // 签名失败不要让整个构建挂掉：先出包，用户仍可用 xattr 绕过
    console.warn('[after-pack] ad-hoc 签名失败（不影响产物）：', err?.message ?? err)
  }
}
