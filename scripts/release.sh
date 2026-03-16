#!/usr/bin/env bash
# LMU Pitwall — release script (replaces: make prepare-dist && make serve)
# Usage: ./scripts/release.sh [--no-bump] [--no-serve] [--no-installer] [--port 8080]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE_DIR="$REPO_DIR/bridge"
DASHBOARD_DIR="$REPO_DIR/dashboard"
DIST_DIR="$REPO_DIR/dist"
TARGET="x86_64-pc-windows-gnu"
PORT=8080
BUMP=true
SERVE=true
INSTALLER=true
ISCC="C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe"
POWERSHELL="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-bump)      BUMP=false ;;
    --no-serve)     SERVE=false ;;
    --no-installer) INSTALLER=false ;;
    --port)         PORT="$2"; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

export PATH="$HOME/.local/bin:$PATH"
source "$HOME/.cargo/env"

cd "$REPO_DIR"

# ── 1. Bump version ────────────────────────────────────────────────────────
if $BUMP; then
  echo "=== Bumping version ==="
  python3 scripts/bump-version.py
fi
VER=$(cat VERSION)
echo "Version: $VER"

# ── 2. Build React dashboard ───────────────────────────────────────────────
echo ""
echo "=== Building React dashboard ==="
cd "$DASHBOARD_DIR" && npm run build
cd "$REPO_DIR"

# ── 3. Build Rust bridge (Windows .exe) ────────────────────────────────────
echo ""
echo "=== Building Rust bridge (Windows) ==="
cd "$BRIDGE_DIR" && cargo zigbuild --target "$TARGET" --release
cd "$REPO_DIR"

# ── 4. Assemble dist/ ──────────────────────────────────────────────────────
echo ""
echo "=== Assembling dist/ ==="
mkdir -p "$DIST_DIR/installer"
cp "$BRIDGE_DIR/target/$TARGET/release/lmu-pitwall.exe" "$DIST_DIR/"
cp installer/lmu-pitwall-installer.iss "$DIST_DIR/installer/"
cp installer/config.json               "$DIST_DIR/installer/"
cp "$DIST_DIR/lmu-pitwall.exe"         "$DIST_DIR/installer/"

# build-installer.bat (Windows line endings)
printf '@echo off\r\necho Building LMU Pitwall Installer...\r\necho.\r\n"C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe" "%%~dp0installer\\lmu-pitwall-installer.iss"\r\nif errorlevel 1 (\r\n    echo.\r\n    echo ERROR: Inno Setup not found.\r\n    echo Please install Inno Setup 6 from: https://jrsoftware.org/isdl.php\r\n    pause\r\n    exit /b 1\r\n)\r\necho.\r\necho Done! Installer created: installer\\LMU-Pitwall-Setup-%s.exe\r\necho.\r\npause\r\n' \
  "$VER" > "$DIST_DIR/build-installer.bat"

# ── 5. Build Inno Setup installer (.exe) ───────────────────────────────────
SETUP_EXE=""
if $INSTALLER; then
  echo ""
  echo "=== Building Inno Setup installer ==="
  WIN_ISS=$(wslpath -w "$DIST_DIR/installer/lmu-pitwall-installer.iss")
  if "$POWERSHELL" -NoProfile -NonInteractive \
      -Command "& { & '$ISCC' '$WIN_ISS'; exit \$LASTEXITCODE }" 2>&1; then
    SETUP_EXE="$DIST_DIR/installer/LMU-Pitwall-Setup-${VER}.exe"
    echo "  Installer created: installer/LMU-Pitwall-Setup-${VER}.exe"
  else
    echo "  WARNING: Inno Setup build failed (ISCC not found or error)."
    echo "  Run dist/build-installer.bat on Windows to create the installer manually."
    INSTALLER=false
  fi
fi

cd "$DIST_DIR"
if [[ -n "$SETUP_EXE" && -f "$SETUP_EXE" ]]; then
  tar czf lmu-pitwall-dist.tar.gz lmu-pitwall.exe installer/ build-installer.bat
else
  tar czf lmu-pitwall-dist.tar.gz lmu-pitwall.exe installer/ build-installer.bat
fi
cd "$REPO_DIR"

EXE_SIZE=$(du -h "$DIST_DIR/lmu-pitwall.exe" | cut -f1)
TAR_SIZE=$(du -h "$DIST_DIR/lmu-pitwall-dist.tar.gz" | cut -f1)
SETUP_SIZE=""
if [[ -n "$SETUP_EXE" && -f "$SETUP_EXE" ]]; then
  SETUP_SIZE=$(du -h "$SETUP_EXE" | cut -f1)
fi

echo ""
echo "============================================"
echo "  LMU Pitwall $VER — dist/ ready"
echo ""
echo "  lmu-pitwall.exe          $EXE_SIZE  (standalone)"
if [[ -n "$SETUP_SIZE" ]]; then
  echo "  LMU-Pitwall-Setup-${VER}.exe  $SETUP_SIZE  (installer)"
fi
echo "  lmu-pitwall-dist.tar.gz  $TAR_SIZE  (bundle)"
echo "============================================"

# ── 6. HTTP server ─────────────────────────────────────────────────────────
if $SERVE; then
  # Get WSL host IP for convenient download URL
  HOST_IP=$(ip route show default 2>/dev/null | awk '{print $3; exit}')
  echo ""
  echo "  HTTP server starting on port $PORT"
  echo ""
  echo "  Download from Windows:"
  echo "    http://${HOST_IP}:${PORT}/lmu-pitwall.exe"
  echo "    http://${HOST_IP}:${PORT}/lmu-pitwall-dist.tar.gz"
  echo ""
  echo "  (Ctrl+C to stop)"
  echo "============================================"
  cd "$DIST_DIR" && python3 -m http.server "$PORT"
fi
