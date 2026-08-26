#!/bin/sh
set -eu

version="1.0.0"
release_root="${AIDLC_RELEASE_ROOT:-https://github.com/sori883/aidlc/releases/download/v${version}}"

case "$(uname -s):$(uname -m)" in
  Darwin:x86_64) asset="aidlc-darwin-amd64" ;;
  Darwin:arm64) asset="aidlc-darwin-arm64" ;;
  Linux:x86_64) asset="aidlc-linux-amd64" ;;
  Linux:aarch64|Linux:arm64) asset="aidlc-linux-arm64" ;;
  *) echo "AI-DLC installer: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

temporary=$(mktemp -d "${TMPDIR:-/tmp}/aidlc-install.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
curl --fail --location --silent --show-error "$release_root/SHA256SUMS" --output "$temporary/SHA256SUMS"
curl --fail --location --silent --show-error "$release_root/$asset" --output "$temporary/aidlc"
expected=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$temporary/SHA256SUMS")
if [ -z "$expected" ]; then
  echo "AI-DLC installer: SHA256SUMS does not contain $asset" >&2
  exit 1
fi
if command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$temporary/aidlc" | awk '{ print $1 }')
elif command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$temporary/aidlc" | awk '{ print $1 }')
else
  echo "AI-DLC installer: shasum or sha256sum is required" >&2
  exit 1
fi
if [ "$actual" != "$expected" ]; then
  echo "AI-DLC installer: downloaded CLI checksum mismatch" >&2
  exit 1
fi
chmod 755 "$temporary/aidlc"
exec "$temporary/aidlc" install "$@"
