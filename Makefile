.PHONY: dev stop eval eval-stack

dev:
	@command -v bun >/dev/null 2>&1 || { echo "missing bun: curl -fsSL https://bun.sh/install | bash"; exit 1; }
	@command -v uv >/dev/null 2>&1 || { echo "missing uv: curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 1; }
	@command -v git >/dev/null 2>&1 || { if [ "$$(uname -s)" = Darwin ]; then echo "missing git: xcode-select --install"; else echo "missing git: sudo apt-get install -y git"; fi; exit 1; }
	@command -v zeta >/dev/null 2>&1 || { echo "missing zeta: git clone https://github.com/hwang2409/zeta .cache/zeta && git -C .cache/zeta checkout --detach '$$(cat zeta.rev)' && uv tool install --editable .cache/zeta"; exit 1; }
	@uv run --no-project python scripts/locked.py bun scripts/dev.ts

stop:
	@command -v bun >/dev/null 2>&1 || { echo "missing bun: curl -fsSL https://bun.sh/install | bash"; exit 1; }
	@command -v uv >/dev/null 2>&1 || { echo "missing uv: curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 1; }
	@uv run --no-project python scripts/locked.py bun scripts/stop.ts

eval:
	@env TASK="$${TASK:-harness-smoke}" $${N:+N="$${N}"} $${MODEL:+MODEL="$${MODEL}"} $${ACHILLES_DIR:+ACHILLES_DIR="$${ACHILLES_DIR}"} $${KEEP_EVAL:+KEEP_EVAL="$${KEEP_EVAL}"} bun scripts/eval.ts --suite "$${TASK:-harness-smoke}"

eval-stack:
	@EVAL_STACK_ONLY=1 KEEP_EVAL=1 bun scripts/eval.ts --suite harness-smoke
