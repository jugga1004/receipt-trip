#!/usr/bin/env bash
# HTML의 <link rel=stylesheet>·<script src>를 파일 내용으로 치환해 한 파일로 만든다.
# 미리보기 창은 file:// HTML을 data: 스냅샷으로 띄워 외부 스크립트를 로드하지 않아서,
# 검증할 때만 쓰는 도구다. 배포에는 쓰지 않는다 — 실제 배포는 원본 파일들을 그대로 올린다.
#
#   bash dev/bundle.sh                       # index.html  → dev/_bundle.html
#   bash dev/bundle.sh dev/test.html dev/_test_bundle.html
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IN="$ROOT/${1:-index.html}"
OUT="$ROOT/${2:-dev/_bundle.html}"
cd "$(dirname "$IN")"   # src 경로는 입력 HTML 기준

awk '
  /<link rel="stylesheet" href="/ {
    match($0, /href="[^"]+"/); f = substr($0, RSTART+6, RLENGTH-7);
    print "<style>"; while ((getline line < f) > 0) print line; close(f);
    print "</style>"; next
  }
  /<script src="/ {
    match($0, /src="[^"]+"/); f = substr($0, RSTART+5, RLENGTH-6);
    print "<script>"; while ((getline line < f) > 0) print line; close(f);
    print "<\/script>"; next
  }
  { print }
' "$IN" > "$OUT"
echo "wrote $OUT ($(wc -c < "$OUT") bytes)"
