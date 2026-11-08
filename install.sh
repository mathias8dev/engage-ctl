#!/bin/sh
set -eu
repo=mathias8dev/engage-ctl
version=${1:-latest}
bin_dir=${ENGAGECTL_BIN_DIR:-"$HOME/.local/bin"}
case "$(uname -s)" in Linux) os=linux;; Darwin) os=darwin;; *) echo "Use install.ps1 on Windows" >&2; exit 1;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) echo "Unsupported architecture" >&2; exit 1;; esac
if [ "$version" = latest ]; then
  url=$(curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location --output /dev/null --write-out '%{url_effective}' "https://github.com/$repo/releases/latest")
  version=${url##*/}; version=${version#v}
fi
version=${version#v}
printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || { echo 'Expected a stable version such as 0.1.0' >&2; exit 1; }
archive="engagectl-$version-$os-$arch.tar.gz"
base="https://github.com/$repo/releases/download/v$version"
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location "$base/SHA256SUMS" --output "$temporary/SHA256SUMS"
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location "$base/$archive" --output "$temporary/$archive"
expected=$(awk -v name="$archive" '$2==name {print $1}' "$temporary/SHA256SUMS")
printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' || { echo 'Missing or invalid checksum' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$temporary/$archive" | awk '{print $1}'); else actual=$(shasum -a 256 "$temporary/$archive" | awk '{print $1}'); fi
[ "$expected" = "$actual" ] || { echo 'Checksum mismatch; installation aborted' >&2; exit 1; }
mkdir "$temporary/unpacked"
tar -xzf "$temporary/$archive" -C "$temporary/unpacked"
[ -f "$temporary/unpacked/engagectl" ] && [ ! -L "$temporary/unpacked/engagectl" ] || { echo 'Missing executable' >&2; exit 1; }
mkdir -p "$bin_dir" "$bin_dir/.engage-ctl-licenses"
cp "$temporary/unpacked/NODE-LICENSE.txt" "$temporary/unpacked/THIRD-PARTY-NOTICES.txt" "$bin_dir/.engage-ctl-licenses/"
destination=$(mktemp "$bin_dir/.engagectl.XXXXXX")
cp "$temporary/unpacked/engagectl" "$destination"
chmod 755 "$destination"
mv -f "$destination" "$bin_dir/engagectl"
"$bin_dir/engagectl" --version
printf 'Installed %s/engagectl. Ensure this directory is on PATH.\n' "$bin_dir"
