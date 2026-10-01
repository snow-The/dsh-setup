#!/usr/bin/env bash
# dsh-setup 一键部署脚本 (Linux / macOS, bash 3.2+)
# 用法: git clone https://github.com/snow-The/dsh-setup.git; cd dsh-setup; ./setup.sh
# 流程: 模板自检 → 预检(远端同步) → 备份旧 profile → 复制模板 → 应用 web.local 覆盖 → 安装依赖(含宿主兼容性判定) → 冒烟测试
# 参数: --skip-install 跳过安装; --skip-smoke 跳过冒烟测试; --force 跳过"远端不同步"/"模板自检失败"的确认
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
TEMPLATE_DIR="$REPO_DIR/profiles/web"
OVERLAY_DIR="$REPO_DIR/profiles/web.local"
SKIP_INSTALL=0
SKIP_SMOKE=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-smoke) SKIP_SMOKE=1 ;;
    --force) FORCE=1 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

echo ""
echo "=== dsh-setup: 部署 web profile ==="

# ---------- 1. 模板自检: 清单/白名单/patch 是否自洽 ----------
# 放在最前面: 模板腐化比安装失败更隐蔽 —— 装出一个"少了一半插件"的 profile 不会报错。
echo ""
echo "==> 模板自检"
if [ -f "$REPO_DIR/scripts/check-template.mjs" ]; then
  if ! node "$REPO_DIR/scripts/check-template.mjs"; then
    echo "模板自检失败,见上方 ✗ 列表。修好再部署,或加 --force 强行继续(不推荐)。" >&2
    if [ "$FORCE" != "1" ]; then exit 1; fi
    echo "(--force: 继续)" >&2
  fi
else
  echo "未找到 scripts/check-template.mjs,跳过模板自检。"
fi

# ---------- 2. 预检: 仓库是否最新 ----------
echo ""
echo "==> 预检: 仓库同步状态"
if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then
  echo "注意: 工作区有未提交改动,将基于当前本地文件部署。"
fi
git -C "$REPO_DIR" fetch --quiet origin 2>/dev/null || true
LOCAL_HEAD="$(git -C "$REPO_DIR" rev-parse HEAD)"
REMOTE_HEAD="$(git -C "$REPO_DIR" rev-parse "@{u}" 2>/dev/null || true)"
if [ -n "$REMOTE_HEAD" ] && [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  echo ""
  echo "!! 本地 HEAD (${LOCAL_HEAD:0:7}) 与远端 (${REMOTE_HEAD:0:7}) 不一致,模板可能过期。" >&2
  echo "!! 建议先执行 git pull 再部署。" >&2
  if [ "$FORCE" != "1" ]; then
    read -r -p "仍要继续部署吗? [y/N] " ans
    case "$ans" in
      y|Y) ;;
      *) echo "已取消。"; exit 1 ;;
    esac
  fi
fi

# ---------- 2. 模板存在性 + 备份已有 profile ----------
if [ ! -d "$TEMPLATE_DIR" ]; then
  echo "找不到模板目录: $TEMPLATE_DIR" >&2
  exit 1
fi
if [ -d "$PROFILE_DIR" ]; then
  BAK="$PROFILE_DIR.bak-$(date +%Y%m%d-%H%M%S)"
  mv "$PROFILE_DIR" "$BAK"
  echo "已备份旧 profile 到: $BAK"
fi

# ---------- 3. 复制模板 ----------
mkdir -p "$(dirname "$PROFILE_DIR")"
cp -R "$TEMPLATE_DIR" "$PROFILE_DIR"
echo "已复制模板到: $PROFILE_DIR"

# ---------- 4. 应用站点覆盖 profiles/web.local/ ----------
if [ -d "$OVERLAY_DIR" ]; then
  echo "应用站点覆盖: $OVERLAY_DIR -> $PROFILE_DIR"
  cp -Rf "$OVERLAY_DIR/." "$PROFILE_DIR/"
  echo "站点覆盖完成。"
else
  echo "未发现 profiles/web.local/,跳过站点覆盖。"
fi

# ---------- 6. 安装依赖 ----------
# 优先走 `dsh plugin --profile web <pnpm 参数>`: 它是 pnpm 的透传包装, 但会额外跑宿主自己的
# 兼容性判定, 并把"哪个插件因 peer 范围不满足会被禁用"连同补救命令一起打出来。
# 裸 pnpm install 不会做这件事 —— 而那正是插件静默不加载的来源。
if [ "$SKIP_INSTALL" != "1" ]; then
  echo ""
  if command -v dsh >/dev/null 2>&1; then
    echo "安装依赖(dsh plugin --profile web install,含宿主兼容性判定)..."
    (cd "$PROFILE_DIR" && dsh plugin --profile web install) || {
      echo "dsh plugin install 失败。常见原因: git 依赖的 allowBuilds 缺条目(见上方 pnpm 提示)," >&2
      echo "或需要能访问 GitHub。可在 profile 目录单独重试: cd $PROFILE_DIR && dsh plugin --profile web install" >&2
      exit 1
    }
  else
    echo "未找到 dsh CLI,退回裸 pnpm install(不会做兼容性判定)。"
    echo "建议: npm i -g @deepseek-ai/dsh 后重跑本脚本。"
    (cd "$PROFILE_DIR" && pnpm install)
  fi
fi

# ---------- 7. 冒烟测试: bundles 可加载性 ----------
if [ "$SKIP_SMOKE" != "1" ]; then
  echo ""
  echo "==> 冒烟测试: 校验 bundles 入口"
  if ! grep -q '"bundles"' "$PROFILE_DIR/package.json"; then
    echo "package.json 缺少 dsh.profile.bundles,冒烟测试无法执行。" >&2
    exit 1
  fi
  FAIL=0
  while IFS= read -r bundle; do
    case "$bundle" in
      @deepseek-ai/*) continue ;;   # 官方层由 dsh 宿主提供,不在 node_modules
    esac
    PKG_DIR="$PROFILE_DIR/node_modules/$bundle"
    if [ ! -f "$PKG_DIR/package.json" ]; then
      echo "  [FAIL] $bundle (未安装)" >&2
      FAIL=1
      continue
    fi
    MAIN="$(node -e "const p=require(process.argv[1]);console.log(p.main||\"\")" "$PKG_DIR/package.json" 2>/dev/null || true)"
    if [ -z "$MAIN" ]; then MAIN="index.js"; fi
    if [ ! -f "$PKG_DIR/$MAIN" ] && [ ! -f "$PKG_DIR/dist/index.js" ]; then
      echo "  [FAIL] $bundle (缺少入口: $MAIN / dist/index.js)" >&2
      FAIL=1
    fi
  done < <(node -e "const p=require(process.argv[1]);console.log((p.dsh&&p.dsh.profile&&p.dsh.profile.bundles||[]).join(String.fromCharCode(10)))" "$PROFILE_DIR/package.json")
  if [ "$FAIL" = "1" ]; then
    echo "冒烟测试失败,见上方 [FAIL] 列表。处理: 重跑 ./setup.sh 或在 profile 目录执行 pnpm install;git 依赖需能访问 GitHub。" >&2
    exit 1
  fi
  echo "冒烟测试通过: 所有 bundle 入口就位。"
fi

# ---------- 8. 完成提示 ----------
echo ""
echo "=== 部署完成! ==="
echo "1. 启动:  dsh web"
echo "2. 首次使用请在 GUI 设置中配置你的 API key / 凭据(本仓库不含任何 key)"
echo "3. 需要远程主机时,在 GUI 的 SSH 插件页添加主机"
echo ""
