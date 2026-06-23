#!/bin/sh
# Crafted PTY output that mimics Codex-style bursts: scrollback fill, a final
# marker line, then a short pause (give the tester time to drop the stream).
set -eu

prefix="${1:-BURST}"

i=0
while [ "$i" -lt 45 ]; do
  printf '%s history %02d\n' "$prefix" "$i"
  i=$((i + 1))
done

printf '%s BOTTOM_MARKER %s\n' "$prefix" "$2"
# Incomplete-looking tail like streaming TUIs sometimes leave before flush.
printf '%s streaming tail ' "$prefix"
sleep 0.15
printf 'complete\n'
