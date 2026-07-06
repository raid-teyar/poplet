# Poplet build / install helpers
#
#   make arch     Rebuild + reinstall on Arch (makepkg -> pacman), then restart
#   make debian   Rebuild + reinstall on Debian/Ubuntu (tauri .deb -> dpkg), then restart
#   make ubuntu   Alias for `make debian`
#   make restart  Restart the resident poplet service (stop, kill, clear socket, start)
#   make clean     Remove makepkg build artifacts (packaging/arch/pkg, src)
#
# The Arch and Debian targets compile from source, install system-wide (needs
# sudo), then hand control to `restart` so the freshly installed binary becomes
# the running instance.

ARCH_DIR := packaging/arch
DEB_DIR  := src-tauri/target/release/bundle/deb

.PHONY: arch arch-clean debian ubuntu restart clean help

help:
	@echo "make arch       - incremental rebuild + reinstall on Arch, then restart"
	@echo "make arch-clean - from-scratch Arch build (wipes Rust cache)"
	@echo "make debian     - rebuild + reinstall on Debian/Ubuntu, then restart"
	@echo "make ubuntu  - alias for 'make debian'"
	@echo "make restart - restart the resident poplet service"
	@echo "make clean   - remove makepkg build artifacts"

# ─── Arch Linux ──────────────────────────────────────────────────────────
# Remove the stale package output and staged install dir, but KEEP src/ — the
# PKGBUILD points CARGO_TARGET_DIR at src/cargo-target, so keeping it lets cargo
# rebuild incrementally (seconds) instead of recompiling every crate (~5 min).
# Use `make arch-clean` for a from-scratch build.
arch:
	rm -rf "$(ARCH_DIR)/pkg" "$(ARCH_DIR)"/*.pkg.tar.zst
	cd "$(ARCH_DIR)" && makepkg -sif
	$(MAKE) restart

# Full from-scratch Arch build (wipes the Rust build cache too).
arch-clean:
	rm -rf "$(ARCH_DIR)/pkg" "$(ARCH_DIR)/src" "$(ARCH_DIR)"/*.pkg.tar.zst
	cd "$(ARCH_DIR)" && makepkg -sif
	$(MAKE) restart

# ─── Debian / Ubuntu ─────────────────────────────────────────────────────
# Delete the old .deb bundle first so a stale package can't be installed, then
# build the Tauri .deb from source and install it. `apt-get install -f` pulls
# any missing runtime dependencies dpkg complained about.
debian:
	rm -rf "$(DEB_DIR)"
	npm ci
	npm run tauri build
	sudo dpkg -i $(DEB_DIR)/*.deb || sudo apt-get install -f -y
	$(MAKE) restart

ubuntu: debian

# ─── Restart the running instance ────────────────────────────────────────
# Stop the service, kill any stray process, delete the stale Unix socket so the
# new binary can bind it, then start the service again.
restart:
	-systemctl --user stop poplet.service
	-pkill -x poplet
	-rm -f "$${XDG_RUNTIME_DIR:-/tmp}/poplet.sock"
	systemctl --user start poplet.service
	@echo "poplet restarted."

clean:
	rm -rf "$(ARCH_DIR)/pkg" "$(ARCH_DIR)/src" "$(ARCH_DIR)"/*.pkg.tar.zst "$(DEB_DIR)"
