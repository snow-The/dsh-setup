#!/usr/bin/env bash
# dsh-setup 一键部署脚本 (Linux / macOS, bash 3.2+)
# 用法: git clone https://github.com/snow-The/dsh-setup.git; cd dsh-setup; ./setup.sh
# 流程: 模板自检 → 预检(远端同步) → 备份旧 profile → 复制模板 → 应用 web.local 覆盖 → 安装依赖(含宿主兼容性判定) → 冒烟测试(入口文件) → 装配验证(dsh --dump-config)
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

# ---------- 1.5 预检: 宿主世代认不认这份 profile ----------
# 2026-10-28 实伤: profile 已装到要 >=0.2.1-rc.2 的一代, 全局 dsh 还停在 0.2.0-rc.2。
# 宿主不报错, 只在启动时静默跳过整包(skipping profile bundle ...), GUI 少一半东西,
# 而部署脚本全程绿灯。所以部署前先问一句「这一代认不认」。
echo ""
echo "==> 预检: 宿主世代"
if [ -f "$REPO_DIR/scripts/preflight-host.mjs" ]; then
  if [ -d "$PROFILE_DIR" ]; then
    node "$REPO_DIR/scripts/preflight-host.mjs" --profile-dir "$PROFILE_DIR"
  else
    node "$REPO_DIR/scripts/preflight-host.mjs"
  fi
  if [ $? -ne 0 ]; then
    # 光拦下来不算修好: 建议不做的事等于没做。就地升级宿主, 再验一次。
    echo ""
    echo "宿主与这份 profile 不同代, 尝试就地升级宿主..."
    if [ -f "$REPO_DIR/scripts/upgrade-host.mjs" ]; then
      node "$REPO_DIR/scripts/upgrade-host.mjs"
      UP_RC=$?
      if [ "$UP_RC" -eq 0 ]; then
        if [ -d "$PROFILE_DIR" ]; then
          node "$REPO_DIR/scripts/preflight-host.mjs" --profile-dir "$PROFILE_DIR"
        else
          node "$REPO_DIR/scripts/preflight-host.mjs"
        fi
        if [ $? -ne 0 ]; then
          echo "升级后预检仍不通过, 见上方列表。" >&2
          if [ "$FORCE" != "1" ]; then exit 1; fi
        fi
      elif [ "$UP_RC" -eq 3 ]; then
        echo "宿主正开着 —— npm 替换全局树会 EBUSY。请先关掉 DSH, 再重跑本脚本。" >&2
        if [ "$FORCE" != "1" ]; then exit 1; fi
      else
        echo "宿主升级失败, 见上方 npm 输出。处理完重跑本脚本。" >&2
        if [ "$FORCE" != "1" ]; then exit 1; fi
      fi
    else
      echo "未找到 scripts/upgrade-host.mjs, 无法自动升级。" >&2
      if [ "$FORCE" != "1" ]; then exit 1; fi
    fi
    echo "(--force: 继续部署; 启动时那些 bundle 仍会被门禁跳过)" >&2
  fi
else
  echo "未找到 scripts/preflight-host.mjs,跳过宿主世代预检。"
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
BAK=""
if [ -d "$PROFILE_DIR" ]; then
  BAK="$PROFILE_DIR.bak-$(date +%Y%m%d-%H%M%S)"
  mv "$PROFILE_DIR" "$BAK"
  echo "已备份旧 profile 到: $BAK"
fi

# ---------- 3. 复制模板 ----------
mkdir -p "$(dirname "$PROFILE_DIR")"
cp -R "$TEMPLATE_DIR" "$PROFILE_DIR"
echo "已复制模板到: $PROFILE_DIR"

# ---------- 3.5 保留既有部署的 patch 层 ----------
# 升级已有部署时，第 2 步把整个旧 profile 挪进 .bak，第 3 步复制的是模板 —— 模板的 patch
# 层是空 `[]`，于是新 profile 一个本机配置都没有（模型路由、权限预设、搜索后端、皮肤…）：
# 起得来，但等于一台没调过的机器。而"直接改部署目录里的 cordis.patch.yml"是操作者最自然的
# 做法，本项目文档此前也一直这么写。
# 所以：模板的 patch 层是"干净"的（去掉注释后只剩 []）时，把旧层接过来；模板自带条目说明
# 这一代模板有意发布配置，那时以模板为准，旧层只留在 .bak 里。
if [ -n "$BAK" ] && [ -f "$BAK/cordis.patch.yml" ]; then
  PRISTINE="$(sed 's/#.*$//' "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null | tr -d '[:space:]')"
  if [ "$PRISTINE" = "[]" ]; then
    cp -f "$BAK/cordis.patch.yml" "$PROFILE_DIR/cordis.patch.yml"
    echo "已保留旧 patch 层: $(wc -c < "$PROFILE_DIR/cordis.patch.yml") 字节（来自 .bak）"
    echo "  · 它是按上一代宿主调的。启动失败就对照 .bak 收窄，或把本机专属配置搬进 profiles/web.local/。"
  else
    echo "模板自带 patch 条目，按模板走；旧层保留在 $BAK"
  fi
fi

# ---------- 4. 应用站点覆盖 profiles/web.local/ ----------
if [ -d "$OVERLAY_DIR" ]; then
  echo "应用站点覆盖: $OVERLAY_DIR -> $PROFILE_DIR"
  cp -Rf "$OVERLAY_DIR/." "$PROFILE_DIR/"
  echo "站点覆盖完成。"
else
  echo "未发现 profiles/web.local/,跳过站点覆盖。"
fi

# ---------- 4.5 保留操作者自己加的依赖(升级不丢插件) ----------
# 部署第 3 步复制的是模板; 模板不认识操作者自己加的依赖(典型: 一个还在开发的本地插件
# link: 到自己的 repo)。复制完它的 bundle 条目就解析不到, 启动时只剩一行 skipping。
# 实现在 scripts/carry-over-deps.mjs, 与 setup.ps1 共用。
if [ -n "$BAK" ] && [ -f "$BAK/package.json" ] && [ -f "$PROFILE_DIR/package.json" ] && [ -f "$REPO_DIR/scripts/carry-over-deps.mjs" ]; then
  CARRIED=0
  while IFS= read -r line; do
    case "$line" in
      "carried: none") ;;
      "carried: "*) echo "  已保留(模板里没有): ${line#carried: }"; CARRIED=$((CARRIED+1)) ;;
      *) echo "  $line" ;;
    esac
  done < <(node "$REPO_DIR/scripts/carry-over-deps.mjs" "$BAK" "$PROFILE_DIR" 2>&1)
  if [ "$CARRIED" -eq 0 ]; then
    echo "操作者没有额外依赖需要保留。"
  else
    echo "  · 装不上会在冒烟测试里暴露。"
  fi
fi

# ---------- 4.6 确保 .npmrc 在 ----------
# 只在 pnpm-workspace.yaml 里写 autoInstallPeers:false 不够 —— 那条要 pnpm 以 workspace
# 模式读到该文件才生效; 用户级配置或从别的 cwd 发起安装都会绕过它。项目级 .npmrc 不需要
# workspace 模式, 且优先级高于用户级配置。
if [ ! -f "$PROFILE_DIR/.npmrc" ]; then
  printf 'auto-install-peers=false\nstrict-peer-dependencies=false\n' > "$PROFILE_DIR/.npmrc"
  echo "已补 .npmrc(关掉 peer 自动安装)。"
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

# ---------- 8. 装配验证: 让宿主真的解析一遍 profile ----------
# 第 7 步只证明"入口文件在磁盘上"。它抓不到: patch 行引用了没装的插件、重复声明,
# 或者宿主在组合配置时发出的任何警告。
#
# 这不是理论问题: 2026-10-12 加的一行 MCP 配置写成了 `- id:` 而不是 `- insert:` 包裹,
# 于是它【整整一周都没有挂载过】, 而磁盘检查完全看不出来。
#
# 关键: `dsh --dump-config` 在这种情况下的【退出码仍然是 0】, 只有 stderr 会响。
# 所以判据必须是 stderr 为空, 不能是退出码。
if [ "$SKIP_SMOKE" != "1" ]; then
  echo ""
  echo "==> 装配验证: dsh --profile web --dump-config (要求 stderr 为空)"
  if ! command -v dsh >/dev/null 2>&1; then
    echo "未找到 dsh CLI,跳过装配验证。建议: npm i -g @deepseek-ai/dsh 后重跑本脚本。" >&2
  else
    DUMP_OUT="$(mktemp)"
    DUMP_ERR="$(mktemp)"
    # set -e 下必须用 `|| DUMP_CODE=$?` 捕获失败，否则脚本会在赋值前就退出。
    DUMP_CODE=0
    dsh --profile web --dump-config >"$DUMP_OUT" 2>"$DUMP_ERR" || DUMP_CODE=$?
    if [ "$DUMP_CODE" -ne 0 ]; then
      echo "装配验证失败: dsh --dump-config 退出码 $DUMP_CODE" >&2
      rm -f "$DUMP_OUT" "$DUMP_ERR"
      exit 1
    fi
    if [ -s "$DUMP_ERR" ]; then
      echo "" >&2
      echo "装配验证失败: 宿主在解析 profile 时报了警告/错误:" >&2
      sed 's/^/  [STDERR] /' "$DUMP_ERR" >&2
      echo "" >&2
      echo "常见原因:" >&2
      echo "  · cordis.patch.yml 里有一行的 id 没有任何声明 —— 要【新建】条目必须用 - insert: 包裹," >&2
      echo "    裸的 '- id: x' 只能配置已存在的条目。" >&2
      echo "  · patch 引用的插件没有装进 profile。" >&2
      rm -f "$DUMP_OUT" "$DUMP_ERR"
      exit 1
    fi
    ID_COUNT="$(grep -c '^[[:space:]]*-[[:space:]]*id:' "$DUMP_OUT" || true)"
    rm -f "$DUMP_OUT" "$DUMP_ERR"
    if [ "${ID_COUNT:-0}" -eq 0 ]; then
      echo "装配验证失败: dump-config 成功但解析出 0 个 loader 条目 —— 这不是正常状态。" >&2
      exit 1
    fi
    echo "装配验证通过: 宿主解析出 $ID_COUNT 个 loader 条目, stderr 为空。"
  fi
fi

# ---------- 9. 宿主解析层 + 四条审计轴 ----------
# 先补一层 $DSH_HOME/profiles/node_modules 指向宿主的 node_modules。
#
# 为什么需要它: 插件的 `import '@deepseek-ai/dsh-tools'` 走 Node 的常规向上查找,
# 而 profile 自己的 node_modules 里【没有】宿主包 —— 它们是 peer, 而本 profile 设了
# autoInstallPeers:false。缺这一层时, 干净机器上的表现是「装得上、解析不到」。
# 2026-10-19 在隔离 home 里实测(Windows): 4 个插件 `@deepseek-ai/dsh-tools 解析不到`,
# 补上这层后立刻变成 硬伤 0 / 不可判定 0 / 合规 16。
#
# 已有这一层就【不碰】: 它可能是有人刻意做的共享 farm。
#
# 之后才跑四条审计轴, 因为:
#   · 插件和宿主不是同一代 —— 0.1.5 的包配 0.2.1 的宿主, 因为 API 面结构性兼容,
#     全绿, 而且可以绿很久(2026-10-19 实测: 全绿了一整代)。
#   · 依赖装不回来 (版本被撤、github 源没了)。
#   · 日志前缀不一致 —— 出事时 grep 一个名字搜不全, 不知道是谁在说话。
# 四条轴都只在**真问题**上退出 1, 对建议性提醒不失败, 所以可以直接当门禁。
if [ "$SKIP_SMOKE" != "1" ]; then
  echo ""

  # 宿主 node_modules: 先按布局推 —— 从 `dsh` 可执行文件往上爬, 每一层都试
  # `<d>/@deepseek-ai/dsh-tools` 和 `<d>/node_modules/@deepseek-ai/dsh-tools`。
  # 这一条能覆盖 npm -g / 私有 prefix / pnpm / npx, 比猜固定位置可靠。
  HOST_NM=""
  probe_host_nm() {
    if [ -f "$1/@deepseek-ai/dsh-tools/package.json" ]; then printf '%s' "$1"; return 0; fi
    if [ -f "$1/node_modules/@deepseek-ai/dsh-tools/package.json" ]; then printf '%s' "$1/node_modules"; return 0; fi
    # npm -g 布局: <prefix>/@deepseek-ai/dsh/node_modules/<宿主包>
    if [ -f "$1/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools/package.json" ]; then
      printf '%s' "$1/@deepseek-ai/dsh/node_modules"; return 0
    fi
    return 1
  }
  DSH_BIN="$(command -v dsh 2>/dev/null || true)"
  if [ -n "$DSH_BIN" ]; then
    REAL_BIN="$(readlink -f "$DSH_BIN" 2>/dev/null || printf '%s' "$DSH_BIN")"
    D="$(dirname "$REAL_BIN")"
    for _ in 1 2 3 4 5 6; do
      if HOST_NM="$(probe_host_nm "$D")"; then break; fi
      [ -z "$D" ] || [ "$D" = "/" ] && break
      D="$(dirname "$D")"
    done
    HOST_NM="${HOST_NM:-}"
  fi
  # 回落: 常见的全局安装位置。
  if [ -z "$HOST_NM" ]; then
    NPM_ROOT="$(npm root -g 2>/dev/null || true)"
    HOST_CANDS=()
    [ -n "$NPM_ROOT" ] && HOST_CANDS+=("$NPM_ROOT/@deepseek-ai/dsh/node_modules")
    HOST_CANDS+=("/usr/lib/node_modules/@deepseek-ai/dsh/node_modules")
    HOST_CANDS+=("/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules")
    for c in "${HOST_CANDS[@]}"; do
      if [ -f "$c/@deepseek-ai/dsh-tools/package.json" ]; then HOST_NM="$c"; break; fi
    done
  fi

  RESOLVE_LAYER="$DSH_HOME/profiles/node_modules"
  if [ -z "$HOST_NM" ]; then
    echo "找不到全局宿主的 node_modules —— 宿主解析层无法建立,'同代'那条轴会被跳过。"
  elif [ -e "$RESOLVE_LAYER" ] || [ -L "$RESOLVE_LAYER" ]; then
    echo "宿主解析层已存在,不覆盖: $RESOLVE_LAYER"
  else
    mkdir -p "$(dirname "$RESOLVE_LAYER")"
    if ln -sfn "$HOST_NM" "$RESOLVE_LAYER" && [ -f "$RESOLVE_LAYER/@deepseek-ai/dsh-tools/package.json" ]; then
      echo "已建立宿主解析层: $RESOLVE_LAYER -> $HOST_NM"
    else
      echo "宿主解析层建立失败(不阻止部署, 但插件的 @deepseek-ai/* 会解析不到)。"
      echo "  手建: ln -sfn '$HOST_NM' '$RESOLVE_LAYER'"
    fi
  fi

  echo ""
  echo "==> 审计: 依赖 / 同代 / 运行时 / 日志"
  AUDIT_ARGS=("$REPO_DIR/scripts/audit-all.mjs" --profile-dir "$PROFILE_DIR")
  [ -n "$HOST_NM" ] && AUDIT_ARGS+=(--host "$HOST_NM")

  if ! node "${AUDIT_ARGS[@]}"; then
    echo "" >&2
    echo "审计失败: 上面失败的轴就是原因, 各轴输出里带 file:line。" >&2
    exit 1
  fi
fi

# ---------- 10. 完成提示 ----------
echo ""
echo "=== 部署完成! ==="
echo "1. 启动:  dsh web"
echo "2. 首次使用请在 GUI 设置中配置你的 API key / 凭据(本仓库不含任何 key)"
echo "3. 需要远程主机时,在 GUI 的 SSH 插件页添加主机"
echo "4. 装配验证: pnpm boot:check  -- 真启动一次,确认装配/服务/无报错"
echo "   (第 8 步的 dump-config 只组合 YAML,看不到模块解析失败;这一步才看得到)"
echo ""
