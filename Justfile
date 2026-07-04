set dotenv-load := true

default:
    just --list

db:
    docker compose up -d postgres

db-down:
    docker compose down

temporal:
    docker compose up -d postgres temporal temporal-ui

temporal-down:
    docker compose stop temporal temporal-ui temporal-admin-tools

pipelines-install:
    cd pipelines && npm install

pipelines-worker-dbaas:
    cd pipelines && npm run worker:dbaas-provisioning

pipelines-worker-docs:
    cd pipelines && npm run worker:document-indexing

# just worker dbaas | just worker docs
worker name:
    just pipelines-worker-{{name}}

web:
    npm run dev -- --host 127.0.0.1

db-studio:
    npm run db:studio

db-generate:
    npm run db:generate

db-migrate:
    npm run db:migrate

# Use only for local prototyping. Committed schema changes should use db-generate + db-migrate.
db-push:
    npm run db:push

build:
    npm run build
