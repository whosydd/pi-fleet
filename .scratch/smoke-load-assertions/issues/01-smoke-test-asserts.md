# 01: The headless load smoke test must judge what it loads

**What to build:** `npm run smoke` must exit non-zero when this package's entry has a loader error, when any of the four fleet tools is absent from the session's active tool list, or when the fleet skill does not load. Today the script prints each of those results and exits 0, so a broken entry passes the check.

The script must also attribute the load to the entry path it handed to the loader. Today it claims any loaded extension whose path contains `pi-fleet`, so a second copy of this package on the same machine can satisfy the assertion while the entry under test failed.

**Blocked by:** None (can start immediately)

**Status:** done

**Branch:** fleet/01-smoke-test-asserts

**Commits:** `5f202eb`, `3977960`

- [x] `npm run smoke` exits 0 on the current tree.
- [x] An entry that throws on load makes `npm run smoke` exit non-zero.
- [x] An entry that registers none of the four fleet tools makes `npm run smoke` exit non-zero.
- [x] A missing or empty fleet skill directory makes `npm run smoke` exit non-zero.
- [x] The script attributes the load to the entry path it was given, not to a substring match on the path.
- [x] The script's docstring describes the assertions that actually run.
- [x] `npm run check` passes: typecheck, tests, smoke, and the planning filter check.

## Comments

- 2026-10-12 review (claude, `job_01_1791736945041_7yvq`): both axes pass. Spec: the
  reviewer rebuilt three broken copies of this package (a throwing entry, an entry
  that registers no fleet tool, an empty `skills/fleet`) and every run exited 1,
  while the healthy tree exits 0. Standards left one reservation: `test/smoke.test.ts`
  now feeds `judgeSmoke` fabricated inputs and no test drives `runSmoke`'s loader
  wiring, so the regression guard for the bad-tree paths is gone. Accepted, with the
  reason on record: the judge's branches are unit-tested, `npm run smoke` covers the
  healthy end-to-end path on every check, and the bad-tree behaviour was verified by
  hand. No further round.
- Commits: `5f202eb` was the first build (attributing the load to the exact entry
  path); `3977960` is the fix round that moved the decision into
  `extensions/lib/smoke.ts`.
