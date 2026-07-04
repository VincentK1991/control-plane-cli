# `cp` — Control Plane CLI

A Cobra-based Go CLI over the control plane's bearer-scoped `/api/v1`
surface (`src/pages/api/v1/*` — see [`../src/README.md`](../src/README.md)).
Same idea as the Claude Code CLI: a thin client, one credential (an API
key), no business logic of its own. See
[`../docs/discussion/cli-tool.md`](../docs/discussion/cli-tool.md) for the
design reasoning.

API keys are dashboard-only — mint one by logging into the web console and
visiting the API Keys page. The CLI only ever consumes a key; it can't
create or revoke one (`cp auth login` just stores a key you already have).

## Build

```sh
cd cli
go build -o cp ./cmd/cp
```

## Configure

Three ways to provide the API key/URL, in precedence order (flag > env var
> config file):

```sh
# 1. Flags, per-invocation
cp --api-url http://127.0.0.1:4321 db list

# 2. Env vars, for scripts/CI
export CP_API_KEY=cp_live_...
export CP_API_URL=http://127.0.0.1:4321

# 3. Config file, for interactive use
cp auth login          # prompts, or pass --key, or reads CP_API_KEY
cp auth status          # confirms the stored key is valid
cp auth logout          # removes it
```

The config file lives at `$XDG_CONFIG_HOME/cp/config.json`
(`~/.config/cp/config.json` by default) with `0600` permissions — it holds
a bearer credential, same sensitivity as an SSH key or `~/.aws/credentials`.

## Commands

```text
cp auth   {login, logout, status}
cp db     {create, list, get, rm}     create/rm take --wait
cp docs   {index, list, status}       index takes --wait, reads --file or stdin
cp usage  show
cp version
```

Every command supports `--output table|json` (default `table`).

`db create` and `docs index` return immediately by default — the server
does the slow part (Kubernetes provisioning; the indexing pipeline) in the
background. Pass `--wait` to block and poll until the resource reaches a
terminal status instead:

```sh
cp db create --name my-db --wait --output json
cp docs index <instance-id> --wait < document.md
```

## Layout

```text
cmd/cp/
  root.go       # root command, persistent --api-url/--output flags, newClient()
  auth.go       # login/logout/status
  db.go         # create/list/get/rm, --wait polling loop (pollDatabaseUntilTerminal)
  docs.go       # index/list/status, --wait polling loop (pollJobUntilTerminal)
  usage.go      # show

internal/
  client/       # REST client — one method per /api/v1 endpoint, no logic beyond
                #   HTTP + JSON. Always sets Content-Type even on bodyless
                #   requests (DELETE): the server's CSRF check rejects
                #   state-changing requests without one — see client.go's
                #   comment and cli_test.go's TestDeleteDatabase regression test.
  config/       # resolves CP_API_KEY/CP_API_URL (flag > env > file), and the
                #   config file read/write/remove
  output/       # table vs JSON rendering, shared by every command
```

## Testing

```sh
go test ./...
```

All tests use `httptest` — no running server required. They cover the
client (request shape, error decoding), config (precedence, file
permissions, round-trip), output formatting, and each command end to end
against a mock server (including `--wait` actually polling, and the
no-API-key-configured path never making a network call). See
`../tests/api-v1.test.ts` for the *backend's* integration tests, which do
require a running stack and are a separate test run — the CLI's tests
deliberately don't depend on one.

For a real end-to-end smoke test against a live stack, see the root
[`README.md`](../README.md)'s "Quick end-to-end sanity check".
