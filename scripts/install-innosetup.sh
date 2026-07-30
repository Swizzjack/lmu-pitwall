#!/usr/bin/env bash
# One-time setup: installs Inno Setup 6 under Wine so release.sh can build the
# Windows installer on Linux without WSL or a Windows machine.
#
# Usage: ./scripts/install-innosetup.sh
#
# Requirements:
#   - wine    (Fedora: sudo dnf install wine / Ubuntu: sudo apt install wine)
#   - curl
#   - Xvfb, if running headless — the Inno Setup installer creates windows even
#     with /VERYSILENT and aborts without a display.
#
# No root? A portable Wine build works just as well and needs no package
# manager (~/.local/bin is already on the PATH that release.sh uses):
#   curl -fL -o /tmp/wine.tar.xz \
#     https://github.com/Kron4ek/Wine-Builds/releases/download/11.14/wine-11.14-amd64-wow64.tar.xz
#   mkdir -p ~/.local/opt && tar xf /tmp/wine.tar.xz -C ~/.local/opt
#   for b in wine wineboot wineserver; do \
#     ln -sf ~/.local/opt/wine-11.14-amd64-wow64/bin/$b ~/.local/bin/$b; done
#
# After this script succeeds once, running release.sh will automatically build
# LMU-Pitwall-Setup-x.x.x.exe alongside the standalone lmu-pitwall.exe.
set -euo pipefail

ISCC="$HOME/.wine/drive_c/Program Files (x86)/Inno Setup 6/ISCC.exe"
CACHE_DIR="$HOME/.cache/lmu-pitwall"
INSTALLER_EXE="$CACHE_DIR/innosetup-installer.exe"
INNOSETUP_URL="https://github.com/jrsoftware/issrc/releases/download/is-6_7_1/innosetup-6.7.1.exe"

# ── Pre-flight ─────────────────────────────────────────────────────────────
if ! command -v wine >/dev/null 2>&1; then
  echo "ERROR: wine is not installed."
  echo "  Fedora:  sudo dnf install wine"
  echo "  Ubuntu:  sudo apt install wine"
  echo "  Without root: see the portable-Wine recipe in this script's header."
  exit 1
fi

if [[ -f "$ISCC" ]]; then
  echo "Inno Setup is already installed under Wine."
  echo "  $ISCC"
  echo ""
  echo "To reinstall, remove the Wine prefix first:"
  echo "  rm -rf \$HOME/.wine"
  exit 0
fi

# The Inno Setup installer needs a display even under /VERYSILENT. Headless it
# dies with 'no driver could be loaded' and a bare exit 1, so wrap it in Xvfb.
WINE_RUN=(wine)
if [[ -z "${DISPLAY:-}" && -z "${WAYLAND_DISPLAY:-}" ]]; then
  if command -v xvfb-run >/dev/null 2>&1; then
    echo "No display detected — running the installer under Xvfb."
    echo ""
    WINE_RUN=(xvfb-run -a -s "-screen 0 1024x768x24" wine)
  else
    echo "ERROR: no display (\$DISPLAY/\$WAYLAND_DISPLAY unset) and xvfb-run not found."
    echo "  The Inno Setup installer creates windows even with /VERYSILENT."
    echo "  Fedora:  sudo dnf install xorg-x11-server-Xvfb"
    echo "  Ubuntu:  sudo apt install xvfb"
    exit 1
  fi
fi

echo "=== Installing Inno Setup 6 under Wine ==="
echo ""

# ── Download ──────────────────────────────────────────────────────────────
mkdir -p "$CACHE_DIR"
if [[ -f "$INSTALLER_EXE" ]]; then
  echo "Installer already cached at $INSTALLER_EXE"
else
  echo "Downloading Inno Setup installer..."
  curl -fL --progress-bar -o "$INSTALLER_EXE" "$INNOSETUP_URL"
  echo ""
fi

# ── Install ───────────────────────────────────────────────────────────────
echo "Installing into Wine prefix (~/.wine)..."
echo "(This may take a minute on first Wine init)"
echo ""
echo "Initializing Wine prefix (first run takes ~30s)..."
WINEDEBUG=-all wineboot --init >/dev/null 2>&1
wineserver -w
echo ""

WINEDEBUG=-all "${WINE_RUN[@]}" "$INSTALLER_EXE" \
  /VERYSILENT /SUPPRESSMSGBOXES /NORESTART \
  /NOICONS
wineserver -w
echo ""

# ── Verify ────────────────────────────────────────────────────────────────
if [[ ! -f "$ISCC" ]]; then
  echo "ERROR: ISCC.exe not found after installation."
  echo "  Expected: $ISCC"
  echo ""
  echo "If Inno Setup installed to a different version path, update ISCC_WINE in release.sh."
  exit 1
fi

echo "Verifying ISCC.exe..."
WINEDEBUG=-all wine "$ISCC" /? 2>/dev/null | head -3 || true
echo ""
echo "============================================"
echo "  Inno Setup installed successfully."
echo ""
echo "  ISCC: $ISCC"
echo ""
echo "  You can now run:"
echo "    ./scripts/release.sh"
echo "============================================"
