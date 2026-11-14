.PHONY: dev stop eval eval-stack eval-selfcheck-real

FULCRUM_CACHE := .cache/fulcrum
FULCRUM_SETUP := FULCRUM_DIR=$(FULCRUM_CACHE) bun scripts/fulcrum.ts --prepare-web

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
	@set -e; \
	mkdir -p .cache; \
	if [ ! -d "$(FULCRUM_CACHE)/.git" ]; then git clone https://github.com/hwang2409/fulcrum "$(FULCRUM_CACHE)" && git -C "$(FULCRUM_CACHE)" checkout --detach "$$(cat fulcrum.rev)"; fi; \
	if [ ! -d "$(FULCRUM_CACHE)/node_modules" ]; then (cd "$(FULCRUM_CACHE)" && bun install --frozen-lockfile); fi; \
	setup='$(FULCRUM_SETUP)'; \
	if ! env FULCRUM_DIR="$(FULCRUM_CACHE)" bun scripts/fulcrum.ts --prepare-web; then echo "eval setup failed; rerun: $$setup" >&2; exit 1; fi; \
	if [ "$${EVAL_SKIP_BROWSER_INSTALL}" != 1 ]; then (cd apps/web && bun node_modules/playwright/cli.js install chromium) || { echo "browser setup failed; rerun: cd apps/web && bun node_modules/playwright/cli.js install chromium" >&2; exit 1; }; fi
	@if [ "$${EVAL_SETUP_ONLY}" != 1 ]; then env $${TASK:+TASK="$${TASK}"} $${N:+N="$${N}"} $${MODEL:+MODEL="$${MODEL}"} $${ACHILLES_DIR:+ACHILLES_DIR="$${ACHILLES_DIR}"} $${ZETA_REV:+ZETA_REV="$${ZETA_REV}"} $${KEEP_EVAL:+KEEP_EVAL="$${KEEP_EVAL}"} bun scripts/eval.ts --suite "$${TASK}"; fi

eval-selfcheck-real:
	@test -n "$${DIR}" || { echo "usage: make eval-selfcheck-real DIR=/path/to/eval-run"; exit 1; }
	@bun scripts/eval-selfcheck-real.ts "$${DIR}"

eval-stack:
	@EVAL_STACK_ONLY=1 KEEP_EVAL=1 bun scripts/eval.ts --suite harness-smoke
