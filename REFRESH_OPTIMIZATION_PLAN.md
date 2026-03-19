# Refresh Optimization Plan

## Problem

Refreshing data is slow and wasteful:
- **Jira**: Re-fetches the full 365-day issue history for every person, even if we fetched it yesterday. Each person requires 2+ paginated API calls with changelog expansion.
- **GitLab**: Strictly sequential (one user at a time), resolves username→ID on every refresh, fetches all events for the past year even if we have recent data. `fetchContributions` and `fetchContributionHistory` both fetch the same events independently.
- **GitHub**: Uses efficient GraphQL batching (10 users/request), but always fetches the full year calendar — no incremental option available in the API.
- **Execution order**: Jira, GitHub, and GitLab run sequentially even though they're independent APIs.
- **No user control**: Clicking refresh always does a full fetch with no visibility into what will happen or options to customize.
- **No overlap protection**: Multiple concurrent refreshes can run simultaneously with no coordination.
- **No progress visibility**: Background refreshes (team/org/all) return `{ status: 'started' }` with no way to check progress or completion.

With ~500 roster members, a full refresh takes a very long time and hammers external APIs unnecessarily.

## Goals

1. **Incremental by default** — only fetch new data since the last refresh
2. **Parallel execution** — run Jira, GitHub, and GitLab concurrently
3. **GitLab-specific optimizations** — cache user IDs, add concurrency, single-pass fetch
4. **Refresh modal** — show users what will happen and let them override defaults
5. **Consistent behavior** — same refresh logic for person, team, org, and all scopes
6. **Refresh state tracking** — prevent overlapping refreshes, report progress

---

## 1. Incremental Jira Refresh

### Current behavior
`fetchPersonMetrics` always runs two JQL queries:
- Resolved issues: `assignee = "id" AND resolved >= -365d`
- In-progress issues: `assignee = "id" AND status in (...)`

This re-fetches all 365 days of resolved issues every time, even if we have data from yesterday.

### New behavior
Add an incremental mode to `fetchPersonMetrics`:
1. Accept an optional `existingData` parameter (the current cached person file)
2. If `existingData` exists and has `fetchedAt`:
   - Query Jira for resolved issues only since `fetchedAt` (minus 1-day buffer for timezone/timing safety): `resolved >= "YYYY-MM-DD"`
   - Always fetch in-progress issues fresh (these represent current state)
   - Merge newly resolved issues into existing resolved list (match by issue key to avoid duplicates, update if changed)
   - Prune stale entries: run a verification JQL query on existing issue keys to detect reassignments and reopened issues (see "Data integrity" below)
   - Remove resolved issues older than the lookback window
   - Recompute aggregates (count, points, cycle time) from the merged set
3. If no `existingData` or force refresh, fetch the full lookback as today

### Data integrity
Issues can be **reassigned** or **reopened** after resolution. The incremental fetch won't detect these changes since it only queries for newly resolved issues. To handle this:
- After merging, run a verification query on the existing issue keys: `key in (KEY-1, KEY-2, ...) AND assignee = "accountId" AND resolved is not EMPTY`
- Remove any cached issues that don't appear in the verification results (they were reassigned or reopened)
- This adds one extra JQL query per person per incremental refresh, but it's a cheap query (no changelog expansion, filtering by known keys)
- Additionally, track `lastFullRefreshAt` in the cached data. If it's older than 7 days, force a full refresh regardless of the `force` flag, so stale data is self-correcting over time.

### Data model change
Add to cached person files:
- `fieldsVersion` string (e.g. `"v1"`). If the cached version doesn't match the current code's version, treat it as a full refresh. This handles the "fields we're fetching haven't changed" requirement — bump the version when we change FIELDS or computed metrics.
- `lastFullRefreshAt` ISO timestamp. Tracks when the last non-incremental fetch happened.

### API change
`fetchPersonMetrics(jiraRequest, name, options)` gains:
- `options.existingData` — cached person metrics to merge into
- `options.since` — ISO date string, overrides auto-detection from existingData

### Implementation
- Modify `server/jira/person-metrics.js`:
  - Add `FIELDS_VERSION = 'v1'` constant
  - Add `FULL_REFRESH_INTERVAL_DAYS = 7` constant
  - Add `mergeResolvedIssues(existing, fresh, lookbackDays)` helper
  - Add `verifyExistingIssues(jiraRequest, accountId, issueKeys)` helper
  - Update `fetchPersonMetrics` to support incremental mode
  - Include `fieldsVersion` and `lastFullRefreshAt` in returned metrics object
- Modify unified refresh handler in `server/dev-server.js`:
  - Read existing cached data before calling `fetchPersonMetrics`
  - Pass it as `existingData` (unless force refresh)

---

## 2. Incremental GitLab Refresh

### Current behavior
For each user, sequentially:
1. Resolve username → user ID via REST API (every time)
2. Fetch all events for the past year via paginated REST API
3. Count events for contribution total

`fetchContributions` and `fetchContributionHistory` do this independently — same user's events are fetched twice.

### Optimizations

#### 2a. Cache user ID resolution
- Persist a `data/gitlab-user-ids.json` map: `{ "username": numericId, ... }`
- On refresh, skip the `/api/v4/users?username=` call for any user already in the map
- Only resolve unknown usernames

#### 2b. Single-pass fetch
- Merge `fetchContributions` and `fetchContributionHistory` into a single `fetchGitlabData(usernames)` function
- Fetch events once per user, return both `totalContributions` and `months` breakdown
- The unified refresh handler writes to both cache files from one result
- **Bug fix**: The current person-scope refresh only calls `fetchContributions` (counts), not `fetchContributionHistory`. The single-pass consolidation fixes this — person refreshes will now also update history data.

#### 2c. Incremental event fetching
- GitLab events API: verify that the `after` parameter on `/users/:id/events` accepts a date string (current code at `server/gitlab/contributions.js:58` uses it as a date and it works). Cross-check against GitLab API docs before relying on this — some API versions treat `after` as a cursor/event ID rather than a date. If it turns out `after` is a cursor, use the `before` and `after` parameters with event IDs, or fall back to client-side date filtering.
- If we have existing cached data with `fetchedAt` for a user, only fetch events since that date
- Merge new events with existing: add new event counts to totals, merge monthly buckets
- Store per-user `fetchedAt` in the cache (already done)

#### 2d. Add concurrency with shared rate limiter
- Currently processes users one at a time with 200ms delay
- GitLab's authenticated rate limit is ~300 req/min (~5 req/sec)
- Use a **shared rate limiter** rather than per-worker delays to stay under the limit:
  - Simple token-bucket approach: a shared `rateLimiter` function that tracks request timestamps and delays as needed to stay under 4 req/sec (with safety margin)
  - 3 concurrent workers sharing the rate limiter
  - Effective throughput improves from ~2.5 users/sec to ~2 users/sec (limited by rate limit, not concurrency) BUT with better network I/O overlap since multiple requests can be in-flight while others wait for responses
- For unauthenticated mode (~10 req/min), reduce to 1 worker with 7s delay (current behavior)

### Implementation
- Modify `server/gitlab/contributions.js`:
  - Add `loadUserIdCache()` / `saveUserIdCache()` using storage
  - Add `createRateLimiter(maxPerSecond)` helper
  - New `fetchGitlabData(usernames, options)` that returns `{ username: { totalContributions, months, fetchedAt } }`
  - Accept `options.existingData` map for incremental fetch
  - Accept `options.concurrency` (default 3)
  - Accept `options.userIdCache` for persistent ID mapping
- Remove separate `fetchContributions` and `fetchContributionHistory` exports
- Export single `fetchGitlabData` function
- Update `server/dev-server.js` to use new single function and write both cache files

---

## 3. GitHub Optimizations

### Current behavior
GraphQL batching is already efficient (10 users per request for counts, 5 for history). The API always returns the full year — no incremental option.

### Optimizations

#### 3a. TTL-based skip
- For each user, check `fetchedAt` in the existing cache
- Skip users whose data was fetched within the TTL (default: 12 hours)
- Only include stale/missing users in the GraphQL batch
- Force refresh overrides this

#### 3b. Single-pass for counts + history
- Currently `fetchContributions` (counts) and `fetchContributionHistory` (monthly breakdown) are separate batch operations with separate GraphQL queries
- The history query already contains the data needed for counts (just sum the daily counts)
- Merge into a single `fetchGithubData(usernames)` that returns both `totalContributions` and `months` from one query
- Use the history batch size (5 per request) since the response is larger
- **Bug fix**: Same as GitLab — person-scope refresh now also updates history data.

### Implementation
- Modify `server/github/contributions.js`:
  - New `fetchGithubData(usernames, options)` returning `{ username: { totalContributions, months, fetchedAt } }`
  - Accept `options.existingData` map for TTL-based skip
  - Accept `options.ttlMs` (default 12 hours)
- Remove separate `fetchContributions` and `fetchContributionHistory` exports
- Export single `fetchGithubData` function
- Update `server/dev-server.js` to use new single function and write both cache files

---

## 4. Parallel Data Source Execution

### Current behavior
The unified refresh handler runs data sources sequentially:
```
Jira (all members) → GitHub (all members) → GitLab (all members) → [trends]
```

### New behavior
Run all three concurrently:
```
┌─ Jira (all members, concurrency 3)
├─ GitHub (batched GraphQL, single-pass counts+history)
└─ GitLab (concurrency 3, single-pass counts+history)
```

For GitHub and GitLab, the single-pass optimization (sections 2b and 3b) means the "trends" data (contribution history) is produced as part of the same fetch — no separate phase needed.

**Note on Jira trends**: Jira trends are derived from cached person metric files by the `buildJiraTrends()` function (`server/dev-server.js`), not from a separate API call. This is a read-time computation that remains unchanged. The parallel execution only affects the fetch phase.

### Implementation
- In the unified refresh handler's `setImmediate` block, use `Promise.allSettled` to run Jira, GitHub, and GitLab concurrently
- Each source handles its own error reporting independently
- Person scope: also run all three concurrently (currently sequential)

---

## 5. Refresh State Tracker

### Purpose
Prevent overlapping refreshes and provide progress visibility.

### Implementation
Simple in-memory state object in `server/dev-server.js`:

```js
const refreshState = {
  running: false,
  scope: null,
  progress: { completed: 0, total: 0, errors: 0 },
  startedAt: null,
  sources: { jira: null, github: null, gitlab: null }  // 'pending'|'running'|'done'|'error'|'skipped'
};
```

- **Before starting a background refresh**: check `refreshState.running`. If true, return HTTP 409 `{ error: 'Refresh already in progress', progress: refreshState.progress }`.
- **During refresh**: update `refreshState.progress` as each member/batch completes.
- **After refresh**: set `running = false`, store final result.
- **Person scope**: exempt from overlap check since it's synchronous and scoped to one person.

### New endpoint
`GET /api/refresh/status` — returns current refresh state:
```json
{
  "running": true,
  "scope": "all",
  "startedAt": "2026-03-19T14:30:00Z",
  "progress": { "completed": 145, "total": 500, "errors": 2 },
  "sources": { "jira": "running", "github": "done", "gitlab": "pending" }
}
```

This keeps the door open for the modal to poll progress, but is not required for MVP.

---

## 6. Refresh Modal UI

### Design
When any refresh button is clicked (person, team, or master), show a modal before starting:

```
┌─────────────────────────────────────────────┐
│  Refresh Data                           [X] │
├─────────────────────────────────────────────┤
│                                             │
│  Scope: Team "Model Serving" (12 members)   │
│                                             │
│  By default, only new data since the last   │
│  refresh will be fetched.                   │
│                                             │
│  Data sources:                              │
│  ☑ Jira metrics                             │
│  ☑ GitHub contributions                     │
│  ☑ GitLab contributions                     │
│                                             │
│  ☐ Force full refresh (re-fetch all         │
│    history, ignoring cache)                  │
│                                             │
│           [Cancel]  [Refresh]               │
└─────────────────────────────────────────────┘
```

### Behavior
- **Data source checkboxes**: default all checked; user can uncheck to skip a source
- **Force full refresh**: unchecked by default; when checked, ignores all incremental/TTL caching and re-fetches everything from scratch
- Modal is the same for person, team, and master refresh — only the scope line changes

### API change
The `POST /api/refresh` body gains optional fields:
```json
{
  "scope": "team",
  "teamKey": "shgriffi::Model Serving",
  "force": false,
  "sources": {
    "jira": true,
    "github": true,
    "gitlab": true
  }
}
```
- `force` (boolean, default `false`): when true, ignores incremental caching
- `sources` (object, default all true): which data sources to refresh

### Input validation
The backend must validate the new fields:
- `force`: must be boolean if present
- `sources`: if present, must be an object with only `jira`, `github`, `gitlab` keys, all boolean values
- Reject unexpected keys in `sources`
- Invalid values return 400 with a descriptive error

### Implementation
- New `src/components/RefreshModal.vue` component
- Props: `scope`, `scopeLabel` (human-readable), `memberCount`
- Emits: `confirm({ force, sources })`, `cancel`
- Update `App.vue`, `TeamRosterView.vue`, `PersonDetail.vue`:
  - Refresh button opens the modal instead of directly calling the API
  - On confirm, call `refreshMetrics` with the selected options
- Update `src/services/api.js`:
  - `refreshMetrics` passes `force` and `sources` to the backend

---

## 7. Backend Refresh Handler Updates

The unified `POST /api/refresh` handler needs to:

1. Validate `force` and `sources` from the request body
2. Check `refreshState.running` — reject with 409 if a background refresh is in progress (person scope exempt)
3. For each enabled source:
   - Read existing cached data
   - If `force` is false, pass existing data for incremental/TTL behavior
   - If `force` is true, pass no existing data (full fetch)
4. Run enabled sources concurrently via `Promise.allSettled`
5. Update `refreshState` throughout execution
6. Write results to storage

### Person scope (synchronous)
```js
const [jiraResult, githubResult, gitlabResult] = await Promise.allSettled([
  sources.jira ? refreshJira(member, { force }) : null,
  sources.github ? refreshGithub(member, { force }) : null,
  sources.gitlab ? refreshGitlab(member, { force }) : null,
]);
// Return results directly
```

### Team/org/all scope (background)
```js
refreshState.running = true;
refreshState.scope = scope;
refreshState.startedAt = new Date().toISOString();

setImmediate(async () => {
  try {
    await Promise.allSettled([
      sources.jira ? refreshJiraAll(members, { force }) : Promise.resolve(),
      sources.github ? refreshGithubAll(members, { force }) : Promise.resolve(),
      sources.gitlab ? refreshGitlabAll(members, { force }) : Promise.resolve(),
    ]);
    saveLastRefreshed();
  } finally {
    refreshState.running = false;
  }
});
```

---

## Implementation Order

1. **Refresh state tracker** (5) — simple, enables overlap protection immediately
2. **GitLab single-pass + user ID cache** (2b, 2a) — biggest per-user speedup
3. **GitHub single-pass** (3b) — simplifies code, no behavior change
4. **Incremental Jira refresh** (1) — biggest overall time savings, most complex
5. **Incremental GitLab refresh** (2c) — complements single-pass
6. **GitHub TTL skip** (3a) — quick win
7. **GitLab concurrency with rate limiter** (2d) — multiplies throughput
8. **Parallel data sources** (4) — handler restructure
9. **Backend handler updates** (7) — wire force/sources/validation together
10. **Refresh modal UI** (6) — frontend, depends on backend support

Steps 1-3 can be done independently. Step 4 is the most complex. Steps 8-10 tie everything together.

---

## Files to Modify

| File | Changes |
|------|---------|
| `server/dev-server.js` | Refresh state tracker, parallel execution, force/sources validation, write both cache files |
| `server/gitlab/contributions.js` | Single-pass fetch, user ID cache, rate limiter, concurrency, incremental |
| `server/github/contributions.js` | Single-pass fetch, TTL skip |
| `server/jira/person-metrics.js` | Incremental mode, fields version, merge logic, verification query |
| `src/components/RefreshModal.vue` | New component |
| `src/components/App.vue` | Show modal on master refresh |
| `src/components/TeamRosterView.vue` | Show modal on team refresh |
| `src/components/PersonDetail.vue` | Show modal on person refresh |
| `src/services/api.js` | Pass `force` and `sources` to refresh endpoint |

## Testing

- Update existing backend tests for new function signatures
- Add tests for incremental merge logic (Jira issue deduplication, date windowing)
- Add tests for Jira verification query (reassigned/reopened issue pruning)
- Add tests for GitLab user ID caching and rate limiter
- Add tests for GitHub TTL skip logic
- Manual testing of the refresh modal across all scopes
- Test overlap protection (409 response when refresh is in progress)
