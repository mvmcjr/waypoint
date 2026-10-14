#!/bin/sh
# /usr/bin/waypoint: behaves like the shim Settings would write
# (build_shim_content in src-tauri/src/commands/cli.rs). Opens the given
# directory, or the current one, and returns the terminal right away.
if [ -z "$1" ]; then
    _wp_dir="$PWD"
else
    _wp_dir="$(cd "$1" 2>/dev/null && pwd)" || _wp_dir="$1"
fi
nohup /usr/lib/waypoint/waypoint "$_wp_dir" > /dev/null 2>&1 &
