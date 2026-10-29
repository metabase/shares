#!/bin/sh
# Install the `share` CLI: curl -fsSL <app>/install.sh | sh
#
# Downloads the binary for this OS and CPU from the GitHub release, checks
# it against SHA256SUMS and puts it in $SHARE_INSTALL_DIR (default
# ~/.local/bin). The worker replaces __APP_URL__ with its own app origin.
#
# Overrides: SHARE_VERSION (release tag, e.g. cli-v0.1.0; default latest),
# SHARE_RELEASE_URL (directory that holds the binaries), SHARE_OS, SHARE_ARCH.
set -eu

APP_URL="__APP_URL__"
DIR="${SHARE_INSTALL_DIR:-$HOME/.local/bin}"
REPO="https://github.com/metabase/shares/releases"
if [ -n "${SHARE_RELEASE_URL:-}" ]; then BASE="${SHARE_RELEASE_URL%/}"
elif [ -n "${SHARE_VERSION:-}" ]; then BASE="$REPO/download/$SHARE_VERSION"
else BASE="$REPO/latest/download"; fi

die() { echo "share install: $*" >&2; exit 1; }

os="${SHARE_OS:-$(uname -s)}"
arch="${SHARE_ARCH:-$(uname -m)}"
case "$os" in
  Darwin|darwin) os=darwin ;;
  Linux|linux) os=linux ;;
  *) die "no binary for OS $os (macOS and Linux only); npm i -g @metabase/shares works where Node 20+ does" ;;
esac
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64|x64) arch=x64 ;;
  *) die "no binary for CPU $arch" ;;
esac
# an x64 shell under Rosetta on Apple silicon: take the native binary
if [ -z "${SHARE_ARCH:-}" ] && [ "$os" = darwin ] && [ "$arch" = x64 ] \
  && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
if [ "$os" = linux ] && [ -f /etc/alpine-release ]; then
  die "no musl (Alpine) binary; npm i -g @metabase/shares works where Node 20+ does"
fi
name="share-$os-$arch"

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else die "needs curl or wget"; fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
echo "downloading $BASE/$name" >&2
fetch "$BASE/$name" "$tmp/$name" || die "download failed: $BASE/$name"
fetch "$BASE/SHA256SUMS" "$tmp/SHA256SUMS" || die "download failed: $BASE/SHA256SUMS"

want="$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$want" ] || die "$name is not in SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/$name" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then got="$(shasum -a 256 "$tmp/$name" | awk '{print $1}')"
else die "needs sha256sum or shasum"; fi
[ "$got" = "$want" ] || die "checksum mismatch for $name (got $got, want $want)"

mkdir -p "$DIR"
chmod 755 "$tmp/$name"
mv -f "$tmp/$name" "$DIR/share"
echo "installed $("$DIR/share" --version) to $DIR/share" >&2

case ":$PATH:" in
  *":$DIR:"*)
    found="$(command -v share || true)"
    [ "$found" = "$DIR/share" ] || echo "note: $found comes first on PATH; remove it or put $DIR first" >&2 ;;
  *) echo "note: $DIR is not on PATH; add it, e.g. echo 'export PATH=\"$DIR:\$PATH\"' >> ~/.profile" >&2 ;;
esac
if [ "$APP_URL" = "https://app.shares.metabase.fyi" ] || [ "$APP_URL" = "__APP""_URL__" ]; then
  echo "next: share login" >&2
else
  echo "next: share login $APP_URL" >&2
fi
