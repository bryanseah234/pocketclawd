# Production Cleanup Plan

Status: **In Progress**
Branch: `feature/pocketclaw-build`

---

## 1. Remove stale CI workflows

- [x] `run-tests.yml` — targets old Python `app/backend/` which is a placeholder README. Delete.
- [x] `run-checks.yml` — Python linters (isort, black, ruff) are irrelevant. Keep only the Prettier + markdownlint steps for docs, or delete entirely since `ci.yml` now covers TypeScript.
- [x] `lint-markdown.yml` / `validate-markdown.yml` — evaluate if redundant with the Prettier check in `run-checks.yml`.

## 2. Remove redundant/legacy files

- [x] `app/backend/README.md` — placeholder from old Python project. Delete `app/backend/` entirely.
- [x] `app/frontend/` — placeholder with only `.prettierrc.json`, `.prettierignore`, and a README. Delete.
- [x] `.lycheeignore` — link checker config for docs that aren't being checked in CI. Evaluate.
- [x] `Makefile` — check if it's still relevant or a leftover from the Python era.
- [x] `pyproject.toml` — check if still needed (DVC? or leftover Python config).
- [x] `.python-version` — leftover from Python project if no Python is used.
- [x] `infra/` — Azure Bicep templates. Evaluate if PocketClaw still uses Azure infra or if this is legacy.
- [x] `notebooks/sample.ipynb` — sample notebook, likely legacy.
- [x] Old Python scripts: `scripts/fetch_sas_token.py` — Azure SAS token fetcher, likely legacy.
- [x] DVC files: `.dvc/`, `.dvcignore`, `scripts/setup_dvc.*`, `scripts/get_data.*` — data versioning for old ML pipeline.

## 3. Fix Docker image reproducibility

- [x] Pin `node:22-slim` to a specific digest in `container/Dockerfile`.

## 4. Document Postgres auth for production

- [x] Add a comment in `docker-compose.yml` noting that `trust` is dev-only and production should use `POSTGRES_PASSWORD`.

## 5. Husky pre-commit — no action needed

The pre-commit hook runs `pnpm run format:fix` which requires deps. This is correct behavior — devs install deps before committing. CI catches formatting issues regardless. No change needed.

## 6. Wiki regen + morning digest stubs — no action needed now

These are explicitly documented as follow-on work in `pocketclaw-wiring.ts`. The audit log clearly marks them as SKIP. No change needed until the agent-container Claude provider is wired.

---

## Execution Order

1. Delete stale workflows + redundant files (one commit)
2. Pin Docker base image (one commit)
3. Add production note to docker-compose (one commit)
4. Push
