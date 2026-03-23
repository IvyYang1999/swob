#!/bin/bash
# 用法: ./scripts/finish-feature.sh 内嵌终端
# 效果: 把分支合并到 master + 清理 worktree + 自动部署

set -e

if [ -z "$1" ]; then
  echo "用法: ./scripts/finish-feature.sh <功能名>"
  echo ""
  echo "当前活跃的功能分支:"
  git worktree list | grep -v "master" | grep -v "bare" || echo "  (无)"
  exit 1
fi

FEATURE_NAME="$1"
BRANCH_NAME="feature/$(echo "$FEATURE_NAME" | tr ' ' '-')"
REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKTREE_DIR="$(dirname "$REPO_ROOT")/swob-$FEATURE_NAME"

# 确认分支存在
if ! git branch --list "$BRANCH_NAME" | grep -q "$BRANCH_NAME"; then
  echo "❌ 分支 $BRANCH_NAME 不存在"
  echo ""
  echo "当前活跃的功能分支:"
  git worktree list
  exit 1
fi

# 检查分支上是否有未提交的改动
if [ -d "$WORKTREE_DIR" ]; then
  cd "$WORKTREE_DIR"
  if [ -n "$(git status --porcelain)" ]; then
    echo "❌ 分支 $BRANCH_NAME 还有未提交的改动:"
    git status --short
    echo ""
    echo "请先 commit 或放弃这些改动"
    exit 1
  fi
  cd "$REPO_ROOT"
fi

echo "==> 切到 master..."
cd "$REPO_ROOT"
git checkout master

echo "==> 合并 $BRANCH_NAME 到 master..."
git merge "$BRANCH_NAME" --no-ff -m "合并功能分支: $FEATURE_NAME"

echo "==> 清理 worktree..."
if [ -d "$WORKTREE_DIR" ]; then
  git worktree remove "$WORKTREE_DIR"
fi
git branch -d "$BRANCH_NAME"

echo ""
echo "✅ 功能 '$FEATURE_NAME' 已合并到 master 并清理完毕"
echo "   post-commit hook 会自动 push + 部署"
