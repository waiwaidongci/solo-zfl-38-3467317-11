#!/usr/bin/env bash
# 非 root 环境下为 Playwright chromium-headless-shell 补齐系统依赖：
# 用 apt 下载 deb 包并解压到项目内 .browser-sysroot/，验收脚本通过
# LD_LIBRARY_PATH 加载，无需 sudo。Debian 12 (bookworm) 适用。
set -euo pipefail
cd "$(dirname "$0")/.."

LISTS=/tmp/apt-lists
CACHE=/tmp/apt-cache
DEBS=/tmp/browser-debs
SYSROOT="$PWD/.browser-sysroot"
ARCH=$(uname -m)
case "$ARCH" in
  aarch64) LIBDIR=aarch64-linux-gnu ;;
  x86_64)  LIBDIR=x86_64-linux-gnu ;;
  *) echo "不支持的架构: $ARCH" >&2; exit 1 ;;
esac

mkdir -p "$LISTS/partial" "$CACHE/archives/partial" "$DEBS" "$SYSROOT"
APT_OPTS=(-o "Dir::State::Lists=$LISTS" -o "Dir::Cache=$CACHE")

apt-get "${APT_OPTS[@]}" update
cd "$DEBS"
apt-get "${APT_OPTS[@]}" download \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libasound2 \
  libatk1.0-0 libatspi2.0-0 libdbus-1-3 libgbm1 libnspr4 libnss3 \
  libxkbcommon0 libdrm2 libwayland-server0 libxi6
for f in *.deb; do dpkg -x "$f" "$SYSROOT"; done

MISSING=$(LD_LIBRARY_PATH="$SYSROOT/lib/$LIBDIR:$SYSROOT/usr/lib/$LIBDIR" \
  ldd "$HOME/.cache/ms-playwright"/chromium_headless_shell-*/chrome-headless-shell-linux-*/chrome-headless-shell 2>/dev/null \
  | grep -c "not found" || true)
if [ "$MISSING" != "0" ]; then
  echo "仍缺少 $MISSING 个库，请检查 ldd 输出" >&2
  exit 1
fi
echo "浏览器依赖已就绪：$SYSROOT"
