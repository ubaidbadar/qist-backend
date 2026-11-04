#!/usr/bin/env bash
set -euo pipefail

root=/srv/qist
release=${1:-}
[[ $# == 1 && $release =~ ^[0-9]{14}-[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || exit 2

exec 9>/run/lock/qist-deploy.lock
flock 9
[[ -L $root/current ]] || { echo "Convert current to a release symlink first" >&2; exit 1; }
previous=$(readlink -f "$root/current")
archive=$root/releases/$release.tgz
destination=$root/releases/$release

runuser -u qist-deploy -- mkdir -- "$destination"
runuser -u qist-deploy -- tar --no-same-owner --no-same-permissions -xzf "$archive" -C "$destination"
runuser -u qist -- test -r "$destination/src/index.ts"
runuser -u qist-deploy -- rm -- "$archive"

switch_release() {
  ln -sfn -- "$1" "$root/.current-next"
  mv -Tf -- "$root/.current-next" "$root/current"
}

healthy() {
  for ((attempt=0; attempt<15; attempt++)); do
    if systemctl is-active --quiet qist-api &&
       curl -fsS --max-time 3 http://127.0.0.1:5001/health >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

switch_release "$destination"
if systemctl restart qist-api && healthy; then
  echo "Activated $release"
  exit 0
fi

echo "Release failed its health check. Restoring $previous" >&2
switch_release "$previous"
if ! systemctl restart qist-api || ! healthy; then
  echo "Previous release also failed its health check" >&2
fi
exit 1
