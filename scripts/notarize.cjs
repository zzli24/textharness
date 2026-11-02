// electron-builder afterSign 钩子：把 .app 交给 Apple 公证（notarize）。
//
// 没配置凭据时自动跳过——所以现在没有 Apple 账号也不影响出包。
// 配好下面几个环境变量后，发版会自动走公证（CI 里就是 GitHub Secrets）：
//
//   APPLE_ID                  你的 Apple ID（邮箱）
//   APPLE_APP_SPECIFIC_PASSWORD  在 appleid.apple.com 生成的 App 专用密码
//   APPLE_TEAM_ID             10 位团队 ID（developer.apple.com/account → Membership）
//
// 还需要签名证书（否则 Apple 直接拒）：
//   CSC_LINK                  .p12 的 base64 或路径
//   CSC_KEY_PASSWORD          .p12 密码
//
// 详见 docs/apple-signing.md

const { execFileSync } = require('node:child_process')

function hasCreds() {
  return Boolean(
    process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
  )
}

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  if (!hasCreds()) {
    console.log('[notarize] 没有配置 Apple 凭据（APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID），跳过公证')
    return
  }

  // 公证要求有真实签名；ad-hoc 签名的包 Apple 会拒绝，这里提前说清楚
  const signed = process.env.CSC_LINK || process.env.CSC_NAME
  if (!signed) {
    console.warn('[notarize] 只有 ad-hoc 签名，Apple 会拒绝公证。先配置 CSC_LINK / CSC_KEY_PASSWORD。')
    return
  }

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = `${context.appOutDir}/${appName}`
  const { notarize } = await import('@electron/notarize')

  console.log(`[notarize] 提交公证 ${appPath}`)
  try {
    await notarize({
      appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    })
    console.log('[notarize] 公证成功')
  } catch (err) {
    // 公证失败就别出包了：一个会被 Gatekeeper 拦的包发出去更麻烦
    console.error('[notarize] 公证失败：', err?.message ?? err)
    throw err
  }

  // 附带把 stapler 打上去，用户离线也能验证
  try {
    execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' })
    console.log('[notarize] 已 staple 到包上')
  } catch (err) {
    console.warn('[notarize] staple 失败：', err?.message ?? err)
  }
}
