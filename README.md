# achilles

a web application for one zeta session. the home page provides a durable zeta chat surface; later slices add page and tool generation.

## setup

```sh
git clone https://github.com/hwang2409/achilles
cd achilles
make dev
```

prerequisites: `make`, `uv`, `bun`, `git`, and `zeta` on `PATH`, plus a provider and model in the zeta home. providers that use an account must be logged in; local ollama does not need credentials.

`make dev` installs dependencies, builds pinned fulcrum packages and the web app when needed, configures achilles in `$ZETA_HOME/mcp.json`, starts or reuses zeta serve, starts achilles in yolo mode, and opens the app.

set `ACHILLES_APPROVAL=ask` to require approval for tool calls.

## eval harness

run the scripted harness with `make eval TASK=harness-smoke`. use `N=2` for repeats and `MODEL=provider/model` to override the settings-resolved model. `make eval-stack` starts a retained private stack for a ux test; it prints the local achilles url, model, tool policy, and retained state path. the stack uses `--tools 'achilles__*,mcp_discover'` and never forwards api-key environment variables.

use `make stop` to stop only processes started by `make dev`.

use `make dev PORT=5297` for another port.

`ZETA_HOME` defaults to `~/.zeta`. `make dev` backs up an existing mcp file once as `mcp.json.achilles-backup` and preserves other servers. if a running zeta serve does not allow the app origin, it is not stopped; the command to restart it with the added origin is printed.
