.PHONY: dev stop

dev:
	@command -v bun >/dev/null 2>&1 || { echo "missing bun: curl -fsSL https://bun.sh/install | bash"; exit 1; }
	@command -v uv >/dev/null 2>&1 || { echo "missing uv: curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 1; }
	@command -v git >/dev/null 2>&1 || { if [ "$$(uname -s)" = Darwin ]; then echo "missing git: xcode-select --install"; else echo "missing git: sudo apt-get install -y git"; fi; exit 1; }
	@command -v zeta >/dev/null 2>&1 || { echo "missing zeta: git clone https://github.com/hwang2409/zeta .cache/zeta && git -C .cache/zeta checkout --detach '$$(cat zeta.rev)' && uv tool install --editable .cache/zeta"; exit 1; }
	@bun scripts/dev.ts

stop:
	@command -v bun >/dev/null 2>&1 || { echo "missing bun: curl -fsSL https://bun.sh/install | bash"; exit 1; }
	@bun scripts/stop.ts
