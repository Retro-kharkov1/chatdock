#!/usr/bin/env bash
# UI-03 acceptance, runs INSIDE an ubuntu container (not on the host).
# Installs the built .deb, starts the app under Xvfb as a non-root user, checks it stays up,
# and saves a screenshot, process list and window tree to /out/acceptance-ui03.
# Read-only for the repo: /deb is mounted read-only, evidence goes to /out.
set -uo pipefail
OUT=/out/acceptance-ui03; mkdir -p "$OUT"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null && apt-get install -y -qq xvfb imagemagick x11-utils procps ca-certificates >/dev/null || { echo "FAIL: tool install"; exit 10; }
DEB=$(ls /deb/google-chat-desktop_*_amd64.deb | head -1)
echo "== installing $DEB"
apt-get install -y "$DEB" 2>&1 | tail -15
ls -l /opt/GoogleChatDesktop/google-chat-desktop /opt/GoogleChatDesktop/chrome-sandbox || exit 11
useradd -m tester
Xvfb :99 -screen 0 1280x800x24 >"$OUT/xvfb.log" 2>&1 &
sleep 3
su tester -c "DISPLAY=:99 HOME=/home/tester /opt/GoogleChatDesktop/google-chat-desktop --disable-gpu --enable-logging=stderr >$OUT/app.log 2>&1 &"
for t in 15 30 60; do
  sleep 15
  echo "== t+${t}s app processes: $(pgrep -fc /opt/GoogleChatDesktop/google-chat-desktop)"
done
ps -eo pid,user,etime,args --sort=start_time | grep -v grep | grep -i "GoogleChatDesktop\|Xvfb" | cut -c1-200 > "$OUT/ps.txt"
cat "$OUT/ps.txt"
DISPLAY=:99 xwininfo -root -tree > "$OUT/windows.txt" 2>&1
grep -i "chat\|google\|electron" "$OUT/windows.txt" | head -10
DISPLAY=:99 import -window root "$OUT/screenshot.png" 2>&1
ls -l "$OUT"
echo "== app.log (errors/URLs)"
grep -i "error\|fatal\|crash\|sandbox\|accounts.google\|chat.google" "$OUT/app.log" | head -20
N=$(pgrep -fc /opt/GoogleChatDesktop/google-chat-desktop)
[ "$N" -ge 1 ] && echo "SMOKE: app UP ($N processes)" && exit 0
echo "SMOKE: app DOWN"; exit 20
