#!/usr/bin/env python3
"""把 nginx 访问日志汇总成站点统计 JSON（给 /admin/ 面板用）。

用法：python3 /root/site-stats.py
输出：/var/www/textharness/admin/stats.json
"""
import gzip
import json
import os
import re
from collections import Counter, defaultdict
from datetime import datetime, timedelta

LOG_DIR = '/var/log/nginx'
OUT = '/var/www/textharness/admin/stats.json'
DAYS = 14
RECENT = 200

# 58.37.209.122 - - [04/Nov/2026:18:50:17 +0800] "GET / HTTP/1.1" 304 0 "-" "UA"
LINE_RE = re.compile(
    r'^(?P<ip>\S+) \S+ \S+ \[(?P<time>[^\]]+)\] '
    r'"(?P<method>\S+) (?P<path>\S+)[^"]*" '
    r'(?P<status>\d{3}) (?P<size>\S+) '
    r'"(?P<ref>[^"]*)" "(?P<ua>[^"]*)"'
)

BOT_RE = re.compile(r'(bot|spider|crawl|curl|wget|python-requests|Go-http-client|HeadlessChrome)', re.I)
WECHAT_RE = re.compile(r'MicroMessenger', re.I)
MOBILE_RE = re.compile(r'(Android|iPhone|iPad|Mobile)', re.I)
DOWNLOAD_RE = re.compile(r'/downloads/(TextHarness-[^?\s]+\.(?:exe|dmg))', re.I)


def ua_kind(ua: str) -> str:
    if BOT_RE.search(ua):
        return 'bot'
    if WECHAT_RE.search(ua):
        return '微信'
    if MOBILE_RE.search(ua):
        return '手机浏览器'
    return '桌面浏览器'


def read_lines():
    names = [n for n in os.listdir(LOG_DIR) if n.startswith('access.log')]
    names.sort(key=lambda n: ('.gz' in n, n), reverse=True)
    for name in names:
        path = os.path.join(LOG_DIR, name)
        try:
            if name.endswith('.gz'):
                with gzip.open(path, 'rt', errors='replace') as fh:
                    yield from fh
            else:
                with open(path, 'r', errors='replace') as fh:
                    yield from fh
        except OSError:
            continue


def main():
    now = datetime.now()
    cutoff = now - timedelta(days=DAYS)

    by_day = defaultdict(lambda: {'views': 0, 'visitors': set(), 'downloads': 0})
    downloads = defaultdict(lambda: {'count': 0, 'last': '', 'by_day': defaultdict(int)})
    paths = Counter()
    referers = Counter()
    ips = Counter()
    ip_last = {}
    kinds = Counter()
    total_views = 0
    all_ips = set()
    recent_downloads = []
    recent_visits = []

    for line in read_lines():
        m = LINE_RE.match(line)
        if not m:
            continue
        try:
            when = datetime.strptime(m.group('time'), '%d/%b/%Y:%H:%M:%S %z')
        except ValueError:
            continue
        if when.replace(tzinfo=None) < cutoff:
            continue

        ip = m.group('ip')
        path = m.group('path').split('?')[0]
        status = m.group('status')
        ua = m.group('ua')
        ref = m.group('ref')
        stamp = when.strftime('%Y-%m-%d %H:%M:%S')
        day = when.strftime('%Y-%m-%d')
        kind = ua_kind(ua)
        kinds[kind] += 1

        # 只把真实页面请求算作「访问」：首页 / index.html / 其它 .html
        # 扫描器打的 /.git/config 之类会被 SPA 兜底成 200，这里一并排除
        is_page = (
            status.startswith(('2', '3'))
            and not path.startswith('/admin')
            and (path == '/' or path.endswith('.html'))
        )
        if is_page:
            total_views += 1
            all_ips.add(ip)
            by_day[day]['views'] += 1
            by_day[day]['visitors'].add(ip)
            paths[path] += 1
            ips[ip] += 1
            ip_last[ip] = when.strftime('%Y-%m-%d %H:%M')
            if ref and ref != '-':
                referers[ref] += 1
            if kind != 'bot':
                recent_visits.append({'time': stamp, 'ip': ip, 'path': path, 'ref': '' if ref == '-' else ref, 'kind': kind})

        dl = DOWNLOAD_RE.search(path)
        if dl and status.startswith(('2', '3')):
            name = dl.group(1)
            item = downloads[name]
            item['count'] += 1
            item['last'] = when.strftime('%Y-%m-%d %H:%M')
            item['by_day'][day] += 1
            by_day[day]['downloads'] += 1
            recent_downloads.append({'time': stamp, 'ip': ip, 'file': name, 'kind': kind})

    days = []
    for i in range(DAYS - 1, -1, -1):
        day = (now - timedelta(days=i)).strftime('%Y-%m-%d')
        row = by_day.get(day, {'views': 0, 'visitors': set(), 'downloads': 0})
        days.append({
            'date': day,
            'views': row['views'],
            'visitors': len(row['visitors']),
            'downloads': row['downloads'],
        })

    today = now.strftime('%Y-%m-%d')
    today_row = next((d for d in days if d['date'] == today), {'views': 0, 'visitors': 0, 'downloads': 0})

    payload = {
        'generatedAt': now.strftime('%Y-%m-%d %H:%M:%S'),
        'totals': {
            'views': total_views,
            'visitors': len(all_ips),
            'downloads': sum(d['count'] for d in downloads.values()),
        },
        'today': today_row,
        'days': days,
        'downloads': [
            {
                'file': name,
                'count': data['count'],
                'last': data['last'],
                'byDay': dict(data['by_day']),
            }
            for name, data in sorted(downloads.items(), key=lambda kv: -kv[1]['count'])
        ],
        'recentDownloads': list(reversed(recent_downloads))[:RECENT],
        'recentVisits': list(reversed(recent_visits))[:RECENT],
        'topPaths': paths.most_common(10),
        'topReferers': referers.most_common(10),
        'topIps': [
            {'ip': ip, 'count': count, 'last': ip_last.get(ip, '')}
            for ip, count in ips.most_common(20)
        ],
        'uaKinds': kinds.most_common(),
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = OUT + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, OUT)
    os.chmod(OUT, 0o644)
    print('ok', payload['totals'], 'today', today_row)


if __name__ == '__main__':
    main()
