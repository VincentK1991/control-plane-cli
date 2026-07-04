# Temporal server config

This directory holds only the Temporal **server's** dynamic config
(`dynamicconfig/development.yaml`), mounted into the `temporal` container
by `docker-compose.yml`. It is not workflow code — for the actual
workflows/activities/workers that run against this server, see
[`../pipelines/README.md`](../pipelines/README.md).

```yaml
frontend.workerHeartbeatsEnabled:
  - value: true
```

Enables worker heartbeats, which is what makes the Temporal Web UI's
Workers page (`http://localhost:8088`) show live worker status. Without
it the server still runs fine; that one page is just empty.

## Why the plain server image, not `temporalio/auto-setup`

See the comment in `../docker-compose.yml`: `auto-setup` was deprecated and
never published past a version that predates worker heartbeats, so this
setup uses the plain `temporalio/server` image and provisions the
`temporal`/`temporal_visibility` Postgres schemas itself, in the same
Postgres instance the app uses (separate databases, no collision with
`control_plane`).

## Starting it

```sh
just temporal   # docker compose up -d postgres temporal temporal-ui
```

See the root [`README.md`](../README.md) for where this fits in the full
setup order, and [`pipelines/README.md`](../pipelines/README.md) for what
actually runs against it.
