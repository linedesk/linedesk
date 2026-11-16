## What and why

<!-- What changes, and the problem it solves. Link the issue. -->

## How I checked it

<!-- Tests added or run; for UI, a screenshot and what you clicked through in the running app. -->

## Checklist

- [ ] `pnpm typecheck` and `pnpm lint` pass; tests for what I changed run locally
- [ ] Writes go through the action registry; new actions have tests (handler, `apply`, permission)
- [ ] Schema changes come with a Drizzle migration; new env variables are in `.env.example`
- [ ] `docker compose up` still works
- [ ] No secrets, real phone numbers, customer data or internal notes
- [ ] Every commit is signed off (`git commit -s`, Developer Certificate of Origin, see CONTRIBUTING.md)

## Decisions

<!-- Product or architecture decisions this change makes, if any. -->
