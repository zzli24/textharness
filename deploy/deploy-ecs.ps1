# 上传站点到 ECS 并部署
#
# 依赖：Windows 自带的 OpenSSH 客户端（ssh.exe / scp.exe），仅支持密钥登录。
# 用法：
#   .\deploy-ecs.ps1 -HostName 1.2.3.4 -User root -KeyFile C:\Users\me\.ssh\id_rsa
#   .\deploy-ecs.ps1 -HostName 1.2.3.4 -User root -Port 2222 -KeyFile ~\.ssh\id_rsa -Domain example.com

param(
  [Parameter(Mandatory = $true)][string]$HostName,
  [string]$User = 'root',
  [int]$Port = 22,
  [Parameter(Mandatory = $true)][string]$KeyFile,
  [string]$Domain = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$site = Join-Path $root 'site'
$setup = Join-Path $PSScriptRoot 'setup.sh'
$remote = '/tmp/textharness-site'

if (-not (Test-Path $site)) { throw "找不到站点目录：$site" }
if (-not (Test-Path $KeyFile)) { throw "找不到私钥：$KeyFile" }

$sshOpts = @('-i', $KeyFile, '-p', "$Port", '-o', 'StrictHostKeyChecking=accept-new')

Write-Host "==> 清理远端临时目录" -ForegroundColor Cyan
& ssh @sshOpts "$User@$HostName" "rm -rf $remote && mkdir -p $remote/deploy"

Write-Host "==> 上传站点（含 84MB 安装包，慢一点属正常）" -ForegroundColor Cyan
& scp @sshOpts -r "$site/*" "$User@${HostName}:$remote/"
& scp @sshOpts $setup "$User@${HostName}:$remote/deploy/setup.sh"

Write-Host "==> 在服务器上执行部署脚本" -ForegroundColor Cyan
& ssh @sshOpts "$User@$HostName" "bash $remote/deploy/setup.sh $remote"

if ($Domain) {
  Write-Host "==> 提示：$Domain 需要在安全组放行 80 端口，并把域名解析到 $HostName" -ForegroundColor Yellow
}

Write-Host "完成。打开 http://$HostName/ 检查。" -ForegroundColor Green
