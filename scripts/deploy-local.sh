#!/bin/bash
set -e

APP_NAME="Swob"
DIST_APP="dist/mac-arm64/${APP_NAME}.app"
INSTALL_DIR="/Applications"

cd "$(dirname "$0")/.."

echo "==> 编译..."
npx electron-vite build

echo "==> 打包 .app (跳过 DMG)..."
npx electron-builder --mac --dir --config.mac.target=dir

if [ ! -d "$DIST_APP" ]; then
  echo "错误：找不到 $DIST_APP"
  exit 1
fi

echo "==> 退出 ${APP_NAME}..."
osascript -e "tell application \"${APP_NAME}\" to quit" 2>/dev/null || true
# 等进程完全退出
for i in $(seq 1 10); do
  pgrep -x "$APP_NAME" >/dev/null 2>&1 || break
  sleep 0.3
done
# 还没退就 kill
pkill -x "$APP_NAME" 2>/dev/null || true
sleep 0.5

echo "==> 替换 ${INSTALL_DIR}/${APP_NAME}.app..."
rm -rf "${INSTALL_DIR}/${APP_NAME}.app"
cp -R "$DIST_APP" "${INSTALL_DIR}/${APP_NAME}.app"

echo "==> 启动 ${APP_NAME}..."
open "${INSTALL_DIR}/${APP_NAME}.app"

echo "==> 完成"
