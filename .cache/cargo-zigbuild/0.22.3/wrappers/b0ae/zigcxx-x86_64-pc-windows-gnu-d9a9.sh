#!/bin/sh
export CARGO_ZIGBUILD_ZIG_VERSION=0.16.0
if [ -n "$SDKROOT" ]; then export SDKROOT; fi
exec "/usr/local/bin/cargo-zigbuild" zig c++ -- -g '-fno-sanitize=all' -target x86_64-windows-gnu "$@"
