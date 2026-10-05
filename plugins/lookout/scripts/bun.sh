#!/bin/sh
# Runs a plugin script with Bun: the one on PATH, a usual install location,
# or the copy an installed Lookout ships, so the app alone is enough.
for b in \
  "$(command -v bun 2>/dev/null)" \
  "$HOME/.bun/bin/bun" \
  /opt/homebrew/bin/bun \
  /usr/local/bin/bun \
  /Applications/Lookout.app/Contents/Resources/app.asar.unpacked/snapshot/bin/bun \
  "$HOME/Applications/Lookout.app/Contents/Resources/app.asar.unpacked/snapshot/bin/bun" \
  "$HOME/.lookout/cli/bun/bin/bun"
do
  if [ -n "$b" ] && [ -x "$b" ]; then exec "$b" "$@"; fi
done
echo "lookout: Bun not found. Install Lookout (it ships Bun) or Bun (https://bun.sh)." >&2
exit 127
