#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
用法：./install.sh [--prefix <目录>]

安装 downvod 和 batchdownvod，要求 Node.js >= 22、npm 和 FFmpeg。
默认使用 npm 的全局安装目录；可指定用户目录以避免管理员权限：

  ./install.sh --prefix "$HOME/.local"

安装后请将 <prefix>/bin 加入 PATH。
EOF
}

die() {
    printf '错误：%s\n' "$*" >&2
    exit 1
}

install_prefix=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --prefix)
            [[ $# -ge 2 && -n "$2" && "$2" != -* ]] || die '--prefix 需要一个目录参数。'
            # Resolve relative paths before changing to the source directory.
            if [[ "$2" = /* ]]; then
                install_prefix="$2"
            else
                install_prefix="$PWD/$2"
            fi
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *) die "未知参数：$1。使用 --help 查看帮助。" ;;
    esac
done

for tool in node npm ffmpeg; do
    command -v "$tool" >/dev/null 2>&1 || die "未找到 $tool，请安装后重试，详见 README.md。"
done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' ||
    die '需要 Node.js >= 22，请升级后重试。'

if [[ -z "$install_prefix" ]]; then
    install_prefix="$(npm prefix --global)"
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

temp_dir="$(mktemp -d)"
trap 'rm -rf -- "$temp_dir"' EXIT
trap 'printf "安装失败，请检查上方错误。若全局目录不可写，可使用 --prefix \"\$HOME/.local\"。\n" >&2' ERR

printf '安装依赖并编译……\n'
# Include dev dependencies even if NODE_ENV=production: TypeScript is needed to build.
npm ci --include=dev --ignore-scripts
npm run build

printf '打包并安装命令……\n'
# Install a built archive so the commands do not depend on this checkout remaining in place.
npm pack --ignore-scripts --pack-destination "$temp_dir" >/dev/null
npm install --global --ignore-scripts --prefix "$install_prefix" "$temp_dir"/*.tgz

printf '\n安装完成：\n  %s/bin/downvod\n  %s/bin/batchdownvod\n' "$install_prefix" "$install_prefix"
printf '请确认 %s/bin 已加入 PATH。用法见 README.md。\n' "$install_prefix"
