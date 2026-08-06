#!/usr/bin/env bash
# Install Node from nodejs.org (not via actions/setup-node).
# Avoids GitHub's action-download API, which has been returning 503/500.
set -euo pipefail

NODE_MAJOR="${NODE_VERSION:-24}"
tmp="${RUNNER_TEMP:-/tmp}/node-dist"
dir="${RUNNER_TEMP:-/tmp}/node-install"
mkdir -p "$tmp" "$dir"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux) platform=linux ;;
  Darwin) platform=darwin ;;
  MINGW*|MSYS*|CYGWIN*) platform=win ;;
  *) echo "unsupported OS: $os" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac

resolve_version() {
  local py=""
  if command -v python3 >/dev/null 2>&1; then py=python3
  elif command -v python >/dev/null 2>&1; then py=python
  fi
  if [[ -n "$py" ]]; then
    NODE_MAJOR="$NODE_MAJOR" "$py" - <<'PY'
import json, os, urllib.request
want = os.environ["NODE_MAJOR"]
with urllib.request.urlopen("https://nodejs.org/dist/index.json", timeout=60) as r:
    data = json.load(r)
for row in data:
    if row["version"].startswith(f"v{want}."):
        print(row["version"].lstrip("v"))
        raise SystemExit(0)
raise SystemExit(f"no node {want} on nodejs.org")
PY
    return
  fi
  case "$NODE_MAJOR" in
    24) echo 24.5.0 ;;
    26) echo 26.0.0 ;;
    *) echo "${NODE_MAJOR}.0.0" ;;
  esac
}

version="$(resolve_version)"
if [[ "$platform" == win ]]; then
  name="node-v${version}-win-${arch}"
  url="https://nodejs.org/dist/v${version}/${name}.zip"
  echo "Installing Node v${version} from ${url}"
  curl -fsSL "$url" -o "${tmp}/node.zip"
  rm -rf "${tmp}/extract" "$dir"
  mkdir -p "${tmp}/extract" "$dir"
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "${tmp}/node.zip" -d "${tmp}/extract"
  else
    powershell.exe -NoProfile -Command \
      "Expand-Archive -Path '${tmp}/node.zip' -DestinationPath '${tmp}/extract' -Force"
  fi
  # zip contains a top-level folder
  mv "${tmp}/extract/${name}" "${dir}/node"
  echo "${dir}/node" >> "$GITHUB_PATH"
  export PATH="${dir}/node:${PATH}"
else
  name="node-v${version}-${platform}-${arch}"
  url="https://nodejs.org/dist/v${version}/${name}.tar.gz"
  echo "Installing Node v${version} from ${url}"
  curl -fsSL "$url" -o "${tmp}/node.tar.gz"
  rm -rf "$dir"
  mkdir -p "$dir"
  tar -xzf "${tmp}/node.tar.gz" -C "$dir" --strip-components=1
  echo "${dir}/bin" >> "$GITHUB_PATH"
  export PATH="${dir}/bin:${PATH}"
fi

node -v
npm -v
