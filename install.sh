#!/usr/bin/env bash
# Public bootstrap: curl -fsSL https://raw.githubusercontent.com/Hamyrappy/pi-agent-kit/main/install.sh | sudo bash
set -euo pipefail
umask 077
if [[ $EUID != 0 ]]; then
  echo 'Запустите установку через sudo bash (или от root).' >&2; exit 1
fi
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
if ! command -v apt-get >/dev/null; then echo 'Нужен Debian/Ubuntu с apt и systemd.' >&2; exit 1; fi
apt-get update -qq
# No upgrade, no NodeSource setup scripts, no needrestart restarts.
apt-get install -y --no-install-recommends ca-certificates curl git xz-utils tar python3 poppler-utils
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
node_ok=false
if command -v node >/dev/null && node -e 'let [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||a===22&&b>=19?0:1)' 2>/dev/null; then node_ok=true; fi
if [[ $node_ok == false ]]; then
  case "$(uname -m)" in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo 'Поддерживаются x86_64 и arm64.' >&2; exit 1;; esac
  base=https://nodejs.org/dist/latest-v22.x
  curl -fsSL --retry 3 "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
  archive=$(awk -v suffix="-linux-$arch.tar.xz" '$2 ~ /^node-v22\./ && substr($2,length($2)-length(suffix)+1)==suffix { print $2; exit }' "$work/SHASUMS256.txt")
  [[ -n $archive ]] || { echo 'Не найден архив Node.' >&2; exit 1; }
  curl -fsSL --retry 3 "$base/$archive" -o "$work/$archive"
  (cd "$work"; awk -v file="$archive" '$2==file' SHASUMS256.txt | sha256sum -c -)
  mkdir -p /opt/pi-kit-node
  tar -xJf "$work/$archive" -C /opt/pi-kit-node --strip-components=1
  chmod 755 /opt/pi-kit-node
  export PATH="/opt/pi-kit-node/bin:$PATH"
fi
target=${PI_KIT_ROOT:-/opt/pi-agent-kit}
[[ $target == /* && $target != / && $target != *$'\n'* ]] || { echo 'PI_KIT_ROOT должен быть абсолютным путём.' >&2; exit 1; }
if [[ -e $target ]]; then echo "Папка $target существует. Для установленного бота: sudo $target/deploy/pi-kit update. Данные не изменены." >&2; exit 1; fi
version=${PI_KIT_VERSION:-main}
git clone --quiet https://github.com/Hamyrappy/pi-agent-kit.git "$work/source"
git -C "$work/source" checkout --quiet "$version"
mkdir -p "$(dirname "$target")"
mv "$work/source" "$target"
if ! node "$target/scripts/provision.mjs"; then
  echo "Установка не завершена. Файлы оставлены в $target; после исправления: sudo env PATH=\"$PATH\" node $target/scripts/provision.mjs" >&2
  exit 1
fi
