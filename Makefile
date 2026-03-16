BRIDGE_DIR := bridge
DASHBOARD_DIR := dashboard
TARGET := x86_64-pc-windows-gnu
DIST_DIR := dist

.PHONY: all build-bridge build-bridge-cross build-dashboard build-all build-release prepare-dist serve dev clean install-deps

## Default target
all: build-all

## Build the Rust bridge for Windows (.exe) using cargo-zigbuild (no mingw needed)
build-bridge:
	@echo "Building Rust bridge for Windows ($(TARGET)) via zig..."
	@mkdir -p $(DIST_DIR)
	cd $(BRIDGE_DIR) && cargo zigbuild --target $(TARGET) --release
	cp $(BRIDGE_DIR)/target/$(TARGET)/release/lmu-pitwall.exe $(DIST_DIR)/
	@echo "Built: $(DIST_DIR)/lmu-pitwall.exe"

## Build the bridge using 'cross' (Docker-based, alternative method)
build-bridge-cross:
	@echo "Building Rust bridge via cross (Docker)..."
	@mkdir -p $(DIST_DIR)
	cd $(BRIDGE_DIR) && cross build --target $(TARGET) --release
	cp $(BRIDGE_DIR)/target/$(TARGET)/release/lmu-pitwall.exe $(DIST_DIR)/
	@echo "Built: $(DIST_DIR)/lmu-pitwall.exe"

## Full release build: React dashboard first (needed by rust-embed), then Windows .exe
build-release: build-dashboard build-bridge
	@echo ""
	@echo "Release complete → $(DIST_DIR)/lmu-pitwall.exe"

## Prepare dist/ for HTTP distribution (installer bundle + tar archive)
prepare-dist:
	@echo "=== Bumping version ==="
	@python3 scripts/bump-version.py
	@echo "=== Building release with new version ==="
	@$(MAKE) build-release
	@echo "=== Preparing distribution ==="
	@mkdir -p $(DIST_DIR)/installer
	@cp installer/lmu-pitwall-installer.iss $(DIST_DIR)/installer/
	@cp installer/config.json $(DIST_DIR)/installer/
	@cp $(DIST_DIR)/lmu-pitwall.exe $(DIST_DIR)/installer/
	@VER=$$(cat VERSION) && printf '@echo off\r\necho Building LMU Pitwall Installer...\r\necho.\r\n"C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe" "%%~dp0installer\\lmu-pitwall-installer.iss"\r\nif errorlevel 1 (\r\n    echo.\r\n    echo ERROR: Inno Setup not found.\r\n    echo Please install Inno Setup 6 from: https://jrsoftware.org/isdl.php\r\n    pause\r\n    exit /b 1\r\n)\r\necho.\r\necho Done! Installer created: installer\\LMU-Dashboard-Setup-%s.exe\r\necho.\r\npause\r\n' "$$VER" > $(DIST_DIR)/build-installer.bat
	@cd $(DIST_DIR) && tar czf lmu-pitwall-dist.tar.gz lmu-pitwall.exe installer/ build-installer.bat
	@echo ""
	@echo "============================================"
	@echo "  Distribution ready in dist/"
	@echo ""
	@echo "  Start HTTP server:"
	@echo "    cd dist && python3 -m http.server 8080"
	@echo ""
	@echo "  Download auf Windows:"
	@echo "    http://localhost:8080/lmu-pitwall.exe          (Standalone)"
	@echo "    http://localhost:8080/lmu-pitwall-dist.tar.gz  (Installer-Bundle)"
	@echo "============================================"

## Build and serve dist/ via HTTP on port 8080
serve: prepare-dist
	@echo "Starting HTTP server on http://0.0.0.0:8080 ..."
	cd $(DIST_DIR) && python3 -m http.server 8080

## Check Rust code (fast, no linking)
check-bridge:
	cd $(BRIDGE_DIR) && cargo check

## Build the React dashboard (production)
build-dashboard:
	@echo "Building React dashboard..."
	cd $(DASHBOARD_DIR) && npm run build
	@echo "Built: $(DASHBOARD_DIR)/dist/"

## Build everything
build-all: build-bridge build-dashboard

## Start development servers
## Run in two terminals: 'make dev-bridge' and 'make dev-dashboard'
dev: dev-dashboard

dev-dashboard:
	@echo "Starting Vite dev server on http://0.0.0.0:5173 ..."
	cd $(DASHBOARD_DIR) && npm run dev

## Install all dependencies
install-deps:
	@echo "Installing dashboard dependencies..."
	cd $(DASHBOARD_DIR) && npm install
	@echo "Installing cargo-zigbuild (zig-based cross-compilation)..."
	cargo install cargo-zigbuild
	@echo "Adding Windows cross-compile target..."
	rustup target add $(TARGET)

## Clean build artifacts
clean:
	cd $(BRIDGE_DIR) && cargo clean
	rm -rf $(DASHBOARD_DIR)/dist
	rm -rf $(DIST_DIR)

## Show help
help:
	@echo "LMU Pitwall — Makefile Targets"
	@echo ""
	@echo "  build-release       Build dashboard then .exe (single binary distribution)"
	@echo "  prepare-dist        build-release + installer bundle + tar.gz in dist/"
	@echo "  serve               prepare-dist + HTTP server on port 8080"
	@echo "  build-bridge        Build Rust .exe only (cargo-zigbuild)"
	@echo "  build-bridge-cross  Build Rust .exe via Docker (no mingw needed)"
	@echo "  check-bridge        Run cargo check (fast syntax check)"
	@echo "  build-dashboard     Build React frontend (production)"
	@echo "  build-all           Build bridge + dashboard"
	@echo "  dev                 Start Vite dev server"
	@echo "  install-deps        Install all dependencies"
	@echo "  clean               Remove build artifacts"
