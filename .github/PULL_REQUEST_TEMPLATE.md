## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Why

<!-- The reasoning, not the diff. What was wrong, or what did this make possible? -->

## Checklist

- [ ] `npm run verify` passes (format, typecheck, build, tests)
- [ ] `ruff check . && pytest -q` passes in `services/api`, if the service changed
- [ ] Tests cover the new behaviour, and assert something reasoned about rather than a snapshot
- [ ] `docs/options.md` updated, if the public API changed
- [ ] `CHANGELOG.md` updated under Unreleased
- [ ] `docs/performance.md` re-measured, if a hot path changed
