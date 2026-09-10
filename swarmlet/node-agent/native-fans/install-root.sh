#!/bin/sh
# Run once with administrator privileges; future max/restore calls need no prompt.
set -eu
user=${1:?user required}
source=${2:?built helper required}
case "$user" in ''|*[!A-Za-z0-9_.-]*) echo 'Unsupported user name' >&2; exit 1;; esac
[ "$(id -u)" = 0 ] || { echo 'Administrator access required' >&2; exit 1; }
[ -f "$source" ] || { echo 'Built helper is missing' >&2; exit 1; }
case "$(uname -s)" in
  Darwin) helper=/Library/PrivilegedHelperTools/swarmlet-fans ;;
  Linux) helper=/usr/local/libexec/swarmlet-fans ;;
  *) echo 'Unsupported operating system' >&2; exit 1 ;;
esac
secure_dir() {
  check=$1
  while :; do
    [ -d "$check" ] && [ ! -L "$check" ] || { echo "Unsafe helper directory: $check" >&2; exit 1; }
    if [ "$(uname -s)" = Darwin ]; then
      owner=$(stat -f %u "$check"); mode=$(stat -f %Lp "$check")
    else
      owner=$(stat -c %u "$check"); mode=$(stat -c %a "$check")
    fi
    [ "$owner" = 0 ] && [ "$((0$mode & 0022))" = 0 ] || { echo "Helper directory must be root owned and not group/world writable: $check" >&2; exit 1; }
    [ "$check" = / ] && break
    check=$(dirname "$check")
  done
}
directory=$(dirname "$helper")
if [ ! -d "$directory" ]; then
  secure_dir "$(dirname "$directory")"
  install -d -o root -m 755 "$directory"
fi
secure_dir "$directory"
[ ! -L "$helper" ] || { echo 'Refusing a symlink at the helper destination' >&2; exit 1; }
install -o root -m 755 "$source" "$helper"
rule=$(mktemp)
trap 'rm -f "$rule"' EXIT
if [ "$(uname -s)" = Darwin ]; then
  printf '%s ALL=(root) NOPASSWD: %s max, %s auto, %s hold\n' "$user" "$helper" "$helper" "$helper" > "$rule"
else
  printf '%s ALL=(root) NOPASSWD: %s max, %s auto\n' "$user" "$helper" "$helper" > "$rule"
fi
visudo -cf "$rule"
[ -d /etc/sudoers.d ] || install -d -o root -m 755 /etc/sudoers.d
sudoers_dir=$(CDPATH='' cd -P -- /etc/sudoers.d && pwd)
secure_dir "$sudoers_dir"
[ ! -L /etc/sudoers.d/swarmlet-fans ] || { echo 'Refusing symlink at sudoers destination' >&2; exit 1; }
install -o root -m 440 "$rule" /etc/sudoers.d/swarmlet-fans
visudo -c
