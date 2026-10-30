#!/usr/bin/env bash
# TextHarness 静态站部署脚本（Ubuntu/Debian 或 CentOS/Aliyun Linux 通用）
# 用法：bash setup.sh /tmp/textharness-site
set -euo pipefail

SRC="${1:-/tmp/textharness-site}"
DEST="/var/www/textharness"

echo "==> 安装 nginx（如果没装）"
if ! command -v nginx >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y nginx
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nginx
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nginx
  else
    echo "!! 没有可用的包管理器，请手动安装 nginx" >&2
    exit 1
  fi
fi

echo "==> 同步站点文件到 $DEST"
mkdir -p "$DEST"
# 保留 downloads 里已有的大文件，避免重复上传时被清空
cp -r "$SRC"/. "$DEST"/
chmod -R a+rX "$DEST"

echo "==> 写入 nginx 站点配置"
cat > /etc/nginx/conf.d/textharness.conf <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    root /var/www/textharness;
    index index.html;

    # 下载大文件：关掉代理缓冲、给足超时
    client_max_body_size 200m;
    send_timeout 300s;

    gzip on;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_types text/plain text/css application/javascript application/json image/svg+xml;

    location /downloads/ {
        add_header Cache-Control "public, max-age=3600";
        add_header Accept-Ranges bytes;
    }

    location ~* \.(png|jpe?g|webp|ico|svg)$ {
        expires 7d;
        add_header Cache-Control "public";
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX

# Debian 系默认站点也会抢 default_server，删掉
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

echo "==> 校验并重载"
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx 2>/dev/null || systemctl restart nginx

echo "==> 放行防火墙（如启用）"
if command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
elif command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
fi

IP="$(curl -s --max-time 3 ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')"
echo
echo "✅ 部署完成：http://${IP}/"
echo "   安装包：http://${IP}/downloads/TextHarness-0.1.0-setup.exe"
