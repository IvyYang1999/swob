#!/bin/bash
# 用法: ./scripts/new-feature.sh 内嵌终端
# 效果: 自动创建分支 + worktree + 在新终端窗口打开 Claude Code

set -e

if [ -z "$1" ]; then
  echo "用法: ./scripts/new-feature.sh <功能名>"
  echo "例如: ./scripts/new-feature.sh 内嵌终端"
  exit 1
fi

FEATURE_NAME="$1"
# 把中文/空格转成合法的分支名
BRANCH_NAME="feature/$(echo "$FEATURE_NAME" | tr ' ' '-')"
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="$(dirname "$REPO_ROOT")/swob-$FEATURE_NAME"

# 检查是否已存在
if [ -d "$WORKTREE_DIR" ]; then
  echo "⚠️  $WORKTREE_DIR 已存在"
  echo "   直接在新终端打开..."
else
  echo "==> 从 master 创建分支: $BRANCH_NAME"
  git worktree add "$WORKTREE_DIR" -b "$BRANCH_NAME" master
  echo "==> Worktree 创建完成: $WORKTREE_DIR"
fi

# 在新终端窗口打开 Claude Code
echo "==> 打开新终端窗口..."
osascript -e "
tell application \"Terminal\"
  activate
  do script \"cd '$WORKTREE_DIR' && echo '🔧 分支: $BRANCH_NAME' && echo '📁 目录: $WORKTREE_DIR' && echo '' && claude\"
end tell
"

echo ""
echo "✅ 新功能分支已就绪"
echo "   分支: $BRANCH_NAME"
echo "   目录: $WORKTREE_DIR"
echo "   Claude Code 已在新终端窗口启动"
echo ""
echo "   做完后运行: ./scripts/finish-feature.sh $FEATURE_NAME"
