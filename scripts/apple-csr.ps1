# 生成 Developer ID 证书需要的私钥和 CSR（证书请求）
#
# 用法： pwsh -File scripts/apple-csr.ps1
#
# 产出（.secrets/ 不会进 git）：
#   developerID.key   私钥 —— 绝对不要外传
#   developerID.csr   上传到 developer.apple.com 换取证书
#
# 之后：下载 Apple 给的 .cer，再跑 scripts/apple-p12.ps1

param(
  [string]$OutDir = '.secrets',
  [string]$Email = '',
  [string]$CommonName = 'TextHarness Developer ID'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Find-OpenSsl {
  $candidates = @(
    'openssl.exe',
    'C:\Program Files\Git\usr\bin\openssl.exe',
    'C:\Program Files\Git\mingw64\bin\openssl.exe',
    'C:\Program Files\OpenSSL-Win64\bin\openssl.exe'
  )
  foreach ($c in $candidates) {
    try {
      $cmd = Get-Command $c -ErrorAction Stop
      return $cmd.Source
    } catch { }
    if (Test-Path $c) { return $c }
  }
  throw "找不到 openssl.exe。装个 Git for Windows（自带 openssl）或直接装 OpenSSL。"
}

$openssl = Find-OpenSsl
Write-Host "使用 openssl: $openssl" -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$keyPath = Join-Path $OutDir 'developerID.key'
$csrPath = Join-Path $OutDir 'developerID.csr'

if (Test-Path $keyPath) {
  Write-Host "私钥已存在：$keyPath（继续会复用这把私钥）" -ForegroundColor Yellow
} else {
  & $openssl genrsa -out $keyPath 2048 2>&1 | Out-Null
  Write-Host "已生成私钥：$keyPath" -ForegroundColor Green
}

$subject = if ($Email) { "/emailAddress=$Email/CN=$CommonName/C=CN" } else { "/CN=$CommonName/C=CN" }
& $openssl req -new -key $keyPath -out $csrPath -subj $subject 2>&1 | Out-Null
if (-not (Test-Path $csrPath)) { throw 'CSR 生成失败' }

Write-Host "已生成 CSR：$csrPath" -ForegroundColor Green
Write-Host ''
Write-Host '下一步：' -ForegroundColor Cyan
Write-Host '  1. 打开 https://developer.apple.com/account/resources/certificates/list'
Write-Host '  2. 右上角 + → 选 Developer ID Application → Continue'
Write-Host '  3. 上传 .secrets/developerID.csr'
Write-Host '  4. 下载 developerID_application.cer'
Write-Host '  5. 回来执行：pwsh -File scripts/apple-p12.ps1 -Cer .\developerID_application.cer'
