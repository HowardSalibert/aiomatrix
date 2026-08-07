#!/usr/bin/env bash
# Shallow checkout of $GITHUB_SHA / $GITHUB_REF without actions/checkout.
set -euo pipefail

token="${GITHUB_TOKEN:?GITHUB_TOKEN required}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
sha="${GITHUB_SHA:?GITHUB_SHA required}"
ref="${GITHUB_REF:-}"

auth="$(printf 'x-access-token:%s' "$token" | base64 | tr -d '\n')"

git init -q
git remote add origin "https://github.com/${repo}.git" 2>/dev/null \
  || git remote set-url origin "https://github.com/${repo}.git"
git config --local http.https://github.com/.extraheader "AUTHORIZATION: basic ${auth}"
# Avoid prompting / hanging on odd auth failures.
git config --local --add safe.directory "*"

fetch_ok=0
if [[ -n "$ref" ]]; then
  for attempt in 1 2 3 4 5; do
    echo "git fetch attempt ${attempt}: ${ref}"
    if git fetch --depth 1 --quiet origin "${ref}"; then
      fetch_ok=1
      break
    fi
    sleep $((attempt * 4))
  done
fi
if [[ "$fetch_ok" -ne 1 ]]; then
  for attempt in 1 2 3 4 5; do
    echo "git fetch attempt ${attempt}: ${sha}"
    if git fetch --depth 1 --quiet origin "${sha}"; then
      fetch_ok=1
      break
    fi
    sleep $((attempt * 4))
  done
fi
if [[ "$fetch_ok" -ne 1 ]]; then
  echo "checkout failed: could not fetch ${ref:-} / ${sha}" >&2
  exit 1
fi

git checkout --force --quiet FETCH_HEAD
git reset --hard --quiet FETCH_HEAD
echo "checked out $(git rev-parse --short HEAD)"
