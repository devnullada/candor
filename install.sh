#!/bin/sh
# Installs the latest Candor release on macOS or Linux:
#   curl -fsSL https://raw.githubusercontent.com/devnullada/candor/master/install.sh | sh
# The binary goes to ~/.candor/bin (CANDOR_INSTALL to change it), checked against the release's
# SHA256SUMS (CANDOR_URL fetches from another place than GitHub). Candor builds with Go.
set -eu

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "candor: no release for $(uname -s); on Windows use install.ps1" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "candor: no release for $(uname -m)" >&2; exit 1 ;;
esac

dir="${CANDOR_INSTALL:-$HOME/.candor/bin}"
base="${CANDOR_URL:-https://github.com/devnullada/candor/releases/latest/download}"
file="candor-$os-$arch"
mkdir -p "$dir"
echo "downloading $base/$file"
curl -fSL --progress-bar "$base/$file" -o "$dir/candor.tmp"
curl -fsSL "$base/SHA256SUMS" -o "$dir/candor.sums"

# The binary must match its line in the release's SHA256SUMS.
want=$(awk -v f="$file" '$2 == f { print $1 }' "$dir/candor.sums")
rm -f "$dir/candor.sums"
if command -v sha256sum >/dev/null 2>&1; then
  have=$(sha256sum "$dir/candor.tmp" | cut -d' ' -f1)
else
  have=$(shasum -a 256 "$dir/candor.tmp" | cut -d' ' -f1)
fi
if [ -z "$want" ] || [ "$have" != "$want" ]; then
  rm -f "$dir/candor.tmp"
  echo "candor: $file doesn't match the release's SHA256SUMS; nothing installed" >&2
  exit 1
fi
chmod +x "$dir/candor.tmp"
mv "$dir/candor.tmp" "$dir/candor"
echo "installed $("$dir/candor" version | head -1) in $dir"

case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "add it to your PATH: export PATH=\"$dir:\$PATH\"" ;;
esac
command -v go >/dev/null 2>&1 || echo "candor builds with Go, which isn't on the PATH: https://go.dev/dl/"
