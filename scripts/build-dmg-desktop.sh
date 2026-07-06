#!/bin/bash
# build-dmg-desktop.sh
# 构建一个可分发的 Swob.dmg 安装包，放到桌面，方便拷到 MacBook 安装。
#
# 用法：npm run dmg   或   bash scripts/build-dmg-desktop.sh
# 产物：~/Desktop/swob-<version>-arm64.dmg
#
# 只产 arm64（Apple Silicon），跳过签名。约 1-2 分钟。

set -e

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
DESKTOP="${HOME}/Desktop"
DMG_NAME="swob-${VERSION}-arm64.dmg"
DIST_DMG="dist/${DMG_NAME}"

echo "==> 编译 electron-vite..."
npx electron-vite build

echo "==> 打包 dmg (arm64, 跳过签名)..."
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg --arm64

if [ ! -f "$DIST_DMG" ]; then
  echo "❌ 找不到 $DIST_DMG"
  echo "   检查 electron-builder.yml 的 artifactName 是否为 swob-\${version}-\${arch}.\${ext}"
  exit 1
fi

echo "==> 复制到桌面..."
cp "$DIST_DMG" "${DESKTOP}/${DMG_NAME}"

echo ""
echo "✅ 完成：${DESKTOP}/${DMG_NAME}"
echo "   拷到 MacBook 双击安装即可。"
