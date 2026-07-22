#!/bin/bash
set -e

APP_NAME="Swob"
DIST_APP="dist/mac-arm64/${APP_NAME}.app"
INSTALL_DIR="/Applications"

cd "$(dirname "$0")/.."

echo "==> 编译..."
npx electron-vite build

echo "==> 打包 .app (跳过 DMG，跳过签名)..."
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir --config.mac.target=dir

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
# 还没退就 kill;SIGTERM 无效(进程 not responding)时必须升级 SIGKILL,
# 否则后面的 open 只会激活旧进程,新版本永远上不去(2026-07-22 实证)。
pkill -x "$APP_NAME" 2>/dev/null || true
sleep 1
if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  echo "==> 旧进程未响应 SIGTERM,强制结束..."
  pkill -9 -x "$APP_NAME" 2>/dev/null || true
  sleep 1
fi
if pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  echo "错误：旧 ${APP_NAME} 进程无法结束,中止部署(避免部署假象)"
  exit 1
fi

echo "==> 替换 ${INSTALL_DIR}/${APP_NAME}.app..."
rm -rf "${INSTALL_DIR}/${APP_NAME}.app"
cp -R "$DIST_APP" "${INSTALL_DIR}/${APP_NAME}.app"

APP_CLI="${INSTALL_DIR}/${APP_NAME}.app/Contents/Resources/cli/cli.js"
echo "==> 安装/更新 CLI..."
if [ -f "$APP_CLI" ]; then
  if CLI_INSTALL_OUTPUT="$(node "$APP_CLI" install 2>&1)"; then
    echo "$CLI_INSTALL_OUTPUT"
  else
    echo "警告：CLI 安装/更新失败，应用仍会继续启动。"
    echo "$CLI_INSTALL_OUTPUT"
  fi
else
  echo "警告：找不到 CLI 入口 $APP_CLI"
fi

echo "==> 启动 ${APP_NAME}..."
open "${INSTALL_DIR}/${APP_NAME}.app"

echo "==> 完成"
