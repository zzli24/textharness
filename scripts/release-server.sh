#!/bin/bash
# 在服务器上执行：提交代码 → 推 GitHub → 打 tag → 等 CI → 拉回 macOS 产物
# 由 scripts/release.ps1 上传并调用，参数：<版本号>
set -u

VERSION="${1:?缺少版本号}"
WORK=/root/th-repo
API=https://api.github.com/repos/zzli24/textharness
DL=/var/www/textharness/downloads
RESULT=/root/release-result.txt
LOG=/root/release.log
: > "$LOG"
: > "$RESULT"

say() { echo "$@" | tee -a "$LOG"; }

say "=== 1. 导入新代码 ($VERSION) ==="
cd "$WORK" || { say "仓库目录不存在"; exit 1; }
rm -rf /tmp/newtree && mkdir -p /tmp/newtree
tar -xf /tmp/release.tar -C /tmp/newtree
# 用新树覆盖旧树，并删掉已不存在的文件（保留 .git）
rsync -a --delete --exclude '.git' /tmp/newtree/ "$WORK"/ >>"$LOG" 2>&1 || {
  # 没有 rsync 时退化为覆盖
  cp -a /tmp/newtree/. "$WORK"/
}

git add -A
git config user.name "TextHarness"
git config user.email "dev@textharness.local"
if git diff --cached --quiet; then
  say "  没有文件变化"
else
  git commit -q -m "release: v$VERSION"
  say "  已提交 $(git rev-parse --short HEAD)"
fi

TOKEN=$(tr -d '\n' < /tmp/.ghtok)
git remote set-url origin "https://zzli24:${TOKEN}@github.com/zzli24/textharness.git"
export GIT_TERMINAL_PROMPT=0
git config http.postBuffer 104857600
git config http.version HTTP/1.1

say "=== 2. 推 main ==="
for i in 1 2 3; do
  out=$(git push origin main:main 2>&1); code=$?
  echo "$out" | sed "s/${TOKEN}/***/g" | tail -2 | tee -a "$LOG"
  [ $code -eq 0 ] && break
  say "  第 $i 次失败，6 秒后重试"
  sleep 6
done

say "=== 3. 打 tag v$VERSION ==="
git tag -f "v$VERSION" >/dev/null 2>&1
for i in 1 2 3; do
  out=$(git push -f origin "v$VERSION" 2>&1); code=$?
  echo "$out" | sed "s/${TOKEN}/***/g" | tail -2 | tee -a "$LOG"
  [ $code -eq 0 ] && break
  sleep 6
done
git remote set-url origin https://github.com/zzli24/textharness.git

if [ $code -ne 0 ]; then
  say "TAG_PUSH_FAILED"
  rm -f /tmp/.ghtok
  exit 1
fi

say "=== 4. 等待 CI ==="
sleep 12
RUN=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
      "$API/actions/runs?per_page=5" \
      | python3 -c "import sys,json;d=json.load(sys.stdin);rs=[r for r in d['workflow_runs'] if r['head_branch']=='v$VERSION'];print(rs[0]['id'] if rs else '')")

if [ -z "$RUN" ]; then
  say "找不到 v$VERSION 的 CI run"
  rm -f /tmp/.ghtok
  exit 1
fi
say "  run id = $RUN"
echo "RUN_ID=$RUN" >> "$RESULT"

CONCL=none
for i in $(seq 1 90); do
  line=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$API/actions/runs/$RUN" \
         | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['status'], d['conclusion'])" 2>/dev/null)
  say "  [$(date +%H:%M:%S)] $line"
  case "$line" in
    completed*) CONCL=$(echo "$line" | awk '{print $2}'); break ;;
  esac
  sleep 20
done

curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$API/actions/runs/$RUN/jobs" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);[print('  job:', j['name'], '->', j['conclusion']) for j in d['jobs']]" | tee -a "$LOG"

if [ "$CONCL" != "success" ]; then
  say "CI_FAILED=$CONCL"
  echo "CI_FAILED=$CONCL" >> "$RESULT"
  rm -f /tmp/.ghtok
  exit 1
fi

say "=== 5. 下载产物 ==="
mkdir -p /root/rel && rm -rf /root/rel/*
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$API/actions/runs/$RUN/artifacts" > /root/rel/list.json
python3 - <<'PY' >> "$LOG"
import json
d = json.load(open('/root/rel/list.json'))
for a in d.get('artifacts', []):
    print(' ', a['id'], a['name'], round(a['size_in_bytes'] / 1048576, 1), 'MB')
PY

# 只下 macOS 产物：Windows 包本地已经打好了，再拉一遍纯属浪费带宽
for id in $(python3 -c "import json;d=json.load(open('/root/rel/list.json'));print(' '.join(str(a['id']) for a in d.get('artifacts',[]) if 'mac' in a['name'].lower()))"); do
  say "  下载 $id"
  curl -sL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
       "$API/actions/artifacts/$id/zip" -o "/root/rel/$id.zip"
done

rm -f /tmp/.ghtok
say "=== 6. 解出 dmg ==="
python3 - "$VERSION" <<'PY' | tee -a "$LOG" >> "$RESULT"
import sys, os, glob, zipfile, hashlib, json
version = sys.argv[1]
dest = '/var/www/textharness/downloads'
os.makedirs(dest, exist_ok=True)
out = {}
for z in glob.glob('/root/rel/*.zip'):
    with zipfile.ZipFile(z) as zf:
        for info in zf.infolist():
            name = os.path.basename(info.filename)
            if not name.lower().endswith('.dmg'):
                continue
            target = os.path.join(dest, name)
            with zf.open(info) as src, open(target, 'wb') as dst:
                while True:
                    chunk = src.read(1 << 20)
                    if not chunk:
                        break
                    dst.write(chunk)
            digest = hashlib.sha256(open(target, 'rb').read()).hexdigest()
            key = 'ARM' if 'arm64' in name else 'X64'
            out[key] = (name, round(os.path.getsize(target) / 1048576, 1), digest)
            print(f'{key} {name} {out[key][1]} MB {digest}')

for key, (name, size, digest) in out.items():
    print(f'{key}_NAME={name}')
    print(f'{key}_SIZE={size}')
    print(f'{key}_SHA={digest}')

print('DONE=yes')
PY

say "=== 6.1 清理旧版本安装包 ==="
find "$DL" -maxdepth 1 -type f \( -name 'TextHarness-*.exe' -o -name 'TextHarness-*.dmg' \) \
     ! -name "TextHarness-$VERSION-*" -print -delete | tee -a "$LOG"

say "=== 完成 ==="
echo "OK=yes" >> "$RESULT"
ls -lh "$DL" | tail -5 | tee -a "$LOG"
