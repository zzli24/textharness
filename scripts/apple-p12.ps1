# 把 Apple 下载的 .cer 和本地私钥打包成 CI 用的 .p12
#
# 用法： pwsh -File scripts/apple-p12.ps1 -Cer .\developerID_application.cer
#
# 前置：先跑过 scripts/apple-csr.ps1（生成 .secrets/developerID.key）
# 产出：
#   .secrets/developerID.p12        证书 + 私钥
#   .secrets/developerID.p12.b64    base64，填到 GitHub Secret:CSC_LINK

param(
  [Parameter(Mandatory = $true)][string]$Cer,
  [string]$OutDir = '.secrets',
  [string]$KeyFile = '',
  [string]$Password = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Find-OpenSsl {
  foreach ($c in @('openssl.exe', 'C:\Program Files\Git\usr\bin\openssl.exe', 'C:\Program Files\Git\mingw64\bin\openssl.exe', 'C:\Program Files\OpenSSL-Win64\bin\openssl.exe')) {
    try { return (Get-Command $c -ErrorAction Stop).Source } catch { }
    if (Test-Path $c) { return $c }
  }
  throw '找不到 openssl.exe'
}

$openssl = Find-OpenSsl
$key = if ($KeyFile) { $KeyFile } else { Join-Path $OutDir 'developerID.key' }
if (-not (Test-Path $key)) { throw "找不到私钥 $key，先跑 scripts/apple-csr.ps1" }
if (-not (Test-Path $Cer)) { throw "找不到证书文件 $Cer" }

if (-not $Password) {
  $sec = Read-Host '给 .p12 设一个密码（填 GitHub Secret:CSC_KEY_PASSWORD 用）' -AsSecureString
  $Password = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  )
}
if (-not $Password) { throw '密码不能为空' }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$crt = Join-Path $OutDir 'developerID.crt'
$p12 = Join-Path $OutDir 'developerID.p12'
$b64 = "$p12.b64"

# Apple 给的是 DER 编码，先转 PEM
& $openssl x509 -inform DER -in $Cer -out $crt 2>&1 | Out-Null
if (-not (Test-Path $crt)) { throw '证书转换失败（确认下载的是 .cer 而不是 .pem）' }

& $openssl pkcs12 -export -inkey $key -in $crt -out $p12 -passout "pass:$Password" -name 'Developer ID Application' 2>&1 | Out-Null
if (-not (Test-Path $p12)) { throw '.p12 生成失败' }

$bytes = [System.IO.File]::ReadAllBytes($p12)
[System.IO.File]::WriteAllText($b64, [Convert]::ToBase64String($bytes), (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host "已生成：" -ForegroundColor Green
Write-Host "  $p12"
Write-Host "  $b64"
Write-Host ''
Write-Host '下一步：把 .secrets/developerID.p12.b64 的全部内容填到 GitHub Secrets:' -ForegroundColor Cyan
Write-Host '  CSC_LINK            = 上面的 base64（一整行，不要换行）'
Write-Host '  CSC_KEY_PASSWORD    = 刚才设的密码'
Write-Host '  APPLE_ID            = 你的 Apple ID 邮箱'
Write-Host '  APPLE_APP_SPECIFIC_PASSWORD = appleid.apple.com 生成的专用密码'
Write-Host '  APPLE_TEAM_ID       = developer.apple.com/account → Membership details'
Write-Host ''
Write-Host '然后记得把 electron-builder.yml 里 mac.hardenedRuntime 改成 true。' -ForegroundColor Yellow
