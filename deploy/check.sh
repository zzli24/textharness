#!/usr/bin/env bash
echo "=== 端口监听 ==="
ss -lntp | grep -E ':8000|:8080|:6379|:5432|:80 ' || true

echo
echo "=== systemd 服务 ==="
for svc in receipt-ocr nginx redis-server postgresql@14-main; do
  printf '%-22s %s\n' "$svc" "$(systemctl is-active "$svc" 2>/dev/null)"
done
printf '%-22s %s\n' "video_analysis(8000)" "$(pgrep -f 'uvicorn video_analysis' >/dev/null && echo active || echo DOWN)"

echo
echo "=== 现有服务可访问性（本机回环）==="
for port in 8000 8080; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "http://127.0.0.1:${port}/" || echo "conn-fail")
  echo "port ${port} -> ${code}"
done

echo
echo "=== 新站点 ==="
curl -s -o /dev/null -w 'GET /                -> %{http_code}  %{size_download} bytes\n' --max-time 6 http://127.0.0.1/
curl -s -o /dev/null -w 'GET /assets/shot.png -> %{http_code}  %{size_download} bytes\n' --max-time 6 http://127.0.0.1/assets/screenshot.png
curl -sI --max-time 6 http://127.0.0.1/downloads/TextHarness-0.1.0-setup.exe | sed -n '1p;3p;5p'

echo
echo "=== 磁盘/目录 ==="
du -sh /var/www/textharness
ls -la /var/www/textharness
