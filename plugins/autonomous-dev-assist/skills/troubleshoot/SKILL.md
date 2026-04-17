---
name: autonomous-dev-troubleshoot
description: Diagnose and fix autonomous-dev issues — daemon problems, stuck requests, cost caps, review failures, agent issues, and crash recovery. Triggered by error reports or "not working" complaints.
user-invocable: true
model: claude-sonnet-4-6
---

You are the troubleshooting assistant for the **autonomous-dev** Claude Code plugin. When users report errors, stuck pipelines, or unexpected behavior, walk them through the appropriate runbook scenario below. Always provide exact commands to run. Be methodical: symptoms first, then diagnostics, then resolution, then prevention.

---

# autonomous-dev Troubleshooting Runbook

## Scenario 1: Daemon Not Starting

### Symptoms
- `autonomous-dev daemon start` outputs an error or hangs
- `autonomous-dev daemon status` reports the service is not running
- No heartbeat file is being written

### Diagnostic Steps

**Step 1: Check if the daemon is installed.**

```bash
# macOS
ls ~/Library/LaunchAgents/com.autonomous-dev.daemon.plist

# Linux
ls ~/.config/systemd/user/autonomous-dev.service
```

If the file does not exist, the daemon has not been installed.

**Step 2: Check bash version.**

```bash
bash --version
```

Must be 4.0 or later. On macOS, the default bash is version 3.

**Step 3: Check dependencies.**

```bash
which claude jq git
```

All three must be in your PATH.

**Step 4: Check for a stale lock file.**

```bash
ls -la ~/.autonomous-dev/daemon.lock
```

If the lock file exists but the PID inside it is not alive, the lock is stale.

**Step 5: Check OS service logs.**

```bash
# macOS -- check launchd output
cat ~/Library/Logs/autonomous-dev/daemon-stdout.log
cat ~/Library/Logs/autonomous-dev/daemon-stderr.log

# Linux -- check systemd journal
journalctl --user -u autonomous-dev --no-pager -n 50
```

### Resolution Steps

1. **Not installed:** Run `autonomous-dev install-daemon`. Use `--force` if reinstalling after a plugin update.
2. **Bash too old (macOS):** Install bash 4+ with `brew install bash`, then reinstall the daemon with `autonomous-dev install-daemon --force`.
3. **Missing dependency:** Install the missing tool (`claude`, `jq`, or `git`), then restart with `autonomous-dev daemon start`.
4. **Stale lock file:** Remove the lock file manually: `rm ~/.autonomous-dev/daemon.lock`, then start with `autonomous-dev daemon start`.
5. **Permission errors:** Check file permissions on the daemon data directory: `ls -la ~/.autonomous-dev/`. Directories should be 700, files should be 600.

### Prevention
- After updating the plugin, always reinstall the daemon with `autonomous-dev install-daemon --force`.
- Keep `claude`, `jq`, `git`, and `bash` in a stable PATH location.
- Do not manually edit the LaunchAgent plist or systemd unit -- use `install-daemon` to regenerate.

---

## Scenario 2: Daemon Not Processing Requests

### Symptoms
- `autonomous-dev daemon status` shows the daemon is running
- New requests are not being picked up
- Cost is not accumulating

### Diagnostic Steps

**Step 1: Check the kill switch.**

```bash
autonomous-dev daemon status
```

Look for `Kill switch: ENGAGED`.

**Step 2: Check the circuit breaker.**

```bash
autonomous-dev daemon status
```

Look for `Circuit breaker: TRIPPED`.

**Step 3: Check cost budgets.**

```bash
autonomous-dev cost
```

If remaining budget is zero or negative, the daemon has paused new work.

**Step 4: Check the repository allowlist.**

```bash
autonomous-dev config show | jq '.config.repositories.allowlist'
```

Your repository must be listed here.

**Step 5: Check the queue.**

```bash
# Look for queued requests in the state directory
ls ~/.autonomous-dev/requests/*/state.json 2>/dev/null | head -5
```

**Step 6: Check daemon logs for errors.**

```bash
# macOS
tail -50 ~/.autonomous-dev/logs/daemon.log | jq '.message' 2>/dev/null || tail -50 ~/.autonomous-dev/logs/daemon.log

# Linux
journalctl --user -u autonomous-dev --no-pager -n 50
```

### Resolution Steps

1. **Kill switch engaged:** Reset with `autonomous-dev kill-switch reset`.
2. **Circuit breaker tripped:** Investigate the crash cause in logs, then reset with `autonomous-dev circuit-breaker reset`.
3. **Cost cap exceeded:** Wait for the daily/monthly reset, or increase caps in your configuration:
   ```bash
   autonomous-dev config show | jq '.config.governance'
   ```
   Edit `~/.claude/autonomous-dev.json` to increase `daily_cost_cap_usd` or `monthly_cost_cap_usd`.
4. **Repository not in allowlist:** Add your repo path to `repositories.allowlist` in `~/.claude/autonomous-dev.json`.
5. **No requests in queue:** Submit a new request through the Claude App, Discord, or Slack.

### Prevention
- Set cost caps high enough for your expected workload.
- Always add new repos to the allowlist before submitting requests.
- Monitor `autonomous-dev daemon status` periodically.

---

## Scenario 3: Request Stuck in a Phase

### Symptoms
- A request shows the same phase for an extended period
- Cost is accumulating with no progress
- No approval prompts are appearing

### Diagnostic Steps

**Step 1: Check the request cost breakdown.**

```bash
autonomous-dev cost --request REQ-XXXXXXXX-XXXX
```

If a phase shows many sessions with zero progress, the request may have hit the retry limit.

**Step 2: Check the request state file.**

```bash
cat ~/.autonomous-dev/requests/REQ-XXXXXXXX-XXXX/state.json | jq '.current_phase, .iteration_count, .status'
```

**Step 3: Check the circuit breaker for this request.**

```bash
cat ~/.autonomous-dev/requests/REQ-XXXXXXXX-XXXX/state.json | jq '.circuit_breaker'
```

**Step 4: Check daemon logs for this request.**

```bash
cat ~/.autonomous-dev/logs/daemon.log | jq 'select(.request_id == "REQ-XXXXXXXX-XXXX")' 2>/dev/null | tail -20
```

**Step 5: Check for pending human approval (trust gate).**

```bash
cat ~/.autonomous-dev/requests/REQ-XXXXXXXX-XXXX/state.json | jq '.pending_approval'
```

**Step 6: Check phase timeout configuration.**

```bash
autonomous-dev config show | jq '.config.state_machine.timeouts_by_phase'
```

### Resolution Steps

1. **Hit retry limit:** The request has failed the review gate too many times. Check the review feedback in the request directory, address the feedback manually, and resubmit.
2. **Pending human approval:** The request is waiting for you at a trust gate. Review and approve or reject it.
3. **Phase timeout exceeded:** The phase ran longer than its configured timeout. Check if the timeout is too short for the complexity of the work:
   ```json
   {
     "state_machine": {
       "timeouts_by_phase": {
         "code": "180m"
       }
     }
   }
   ```
4. **Context window exhausted:** If the state file shows `context_window_threshold_pct` was exceeded, the phase ran out of context. This typically means the task is too large; consider decomposing it.
5. **Force cleanup and retry:**
   ```bash
   autonomous-dev cleanup --request REQ-XXXXXXXX-XXXX
   ```

### Prevention
- Set appropriate timeouts for complex tasks (especially the `code` phase).
- Monitor active requests with `autonomous-dev cost`.
- Keep the scope of each request focused -- large requests are more likely to stall.

---

## Scenario 4: Cost Cap Exceeded

### Symptoms
- `autonomous-dev cost` shows remaining budget at zero or negative
- Daemon is pausing new work
- Notifications about cost cap being hit

### Diagnostic Steps

**Step 1: Check current spending.**

```bash
autonomous-dev cost
```

Shows today's spend, monthly spend, and remaining budgets.

**Step 2: Identify expensive requests.**

```bash
autonomous-dev cost --daily
```

Shows per-day cost breakdown for the current month.

**Step 3: Check per-request costs.**

```bash
autonomous-dev cost --request REQ-XXXXXXXX-XXXX
```

Shows per-phase cost breakdown to identify which phases consumed the most.

**Step 4: Check current caps.**

```bash
autonomous-dev config show | jq '.config.governance'
```

### Resolution Steps

1. **Daily cap exceeded:** Wait until midnight UTC for the daily reset, or increase `governance.daily_cost_cap_usd` in your config.
2. **Monthly cap exceeded:** Wait until the first of the next month, or increase `governance.monthly_cost_cap_usd`.
3. **Per-request cap exceeded:** The single request was too expensive. Check why:
   - Many review iterations (document kept failing quality gate)?
   - Large codebase requiring many turns?
   - Consider decomposing the request into smaller tasks.
4. **Adjust caps:**
   ```json
   {
     "governance": {
       "daily_cost_cap_usd": 200.00,
       "monthly_cost_cap_usd": 4000.00,
       "per_request_cost_cap_usd": 100.00
     }
   }
   ```
   Validate after editing: `autonomous-dev config validate`.

### Prevention
- Set per-request caps to catch runaway individual requests before they consume the daily budget.
- Start with conservative caps and increase as you understand your usage patterns.
- Review `autonomous-dev cost --daily` periodically to spot trends.
- Keep request scope small to reduce per-request costs.

---

## Scenario 5: Review Gate Failures

### Symptoms
- A document keeps failing review and iterating
- The pipeline escalates to a human after max iterations
- Quality scores are consistently below threshold

### Diagnostic Steps

**Step 1: Check review scores.**

Look in the request directory for review results:

```bash
ls ~/.autonomous-dev/requests/REQ-XXXXXXXX-XXXX/reviews/
cat ~/.autonomous-dev/requests/REQ-XXXXXXXX-XXXX/reviews/*.json | jq '.score, .feedback_summary'
```

**Step 2: Check the iteration count.**

```bash
cat ~/.autonomous-dev/requests/REQ-XXXXXXXX-XXXX/state.json | jq '.iteration_count'
```

**Step 3: Check threshold configuration.**

```bash
autonomous-dev config show | jq '.config.review_gates'
```

**Step 4: Check for reviewer disagreement.**

```bash
cat ~/.autonomous-dev/requests/REQ-XXXXXXXX-XXXX/reviews/*.json | jq '.individual_scores'
```

If reviewers diverge by more than the `disagreement_threshold` (default: 15 points), the system escalates regardless of average score.

### Resolution Steps

1. **Score slightly below threshold:** Consider lowering the threshold temporarily for this document type:
   ```json
   {
     "review_gates": {
       "thresholds_by_type": {
         "PRD": 80
       }
     }
   }
   ```
2. **Consistent low scores:** The request description may be too vague. Provide more detail about requirements, constraints, and acceptance criteria.
3. **Reviewer disagreement:** This often means the requirements are ambiguous. Clarify the request and resubmit.
4. **Max iterations reached:** Review the feedback from all iterations, incorporate the suggestions, and submit a new, improved request.
5. **Increase iteration limit (use with caution):**
   ```json
   {
     "review_gates": {
       "max_iterations": 5
     }
   }
   ```

### Prevention
- Write clear, specific request descriptions with concrete acceptance criteria.
- Start with the default thresholds; only adjust after understanding the scoring rubrics.
- Use `autonomous-dev agent dashboard` to monitor reviewer agent quality.

---

## Scenario 6: Agent Performance Issues

### Symptoms
- An agent's approval rate is declining
- Anomaly alerts are appearing
- Quality scores are trending downward
- Escalation rate is increasing

### Diagnostic Steps

**Step 1: Check the agent dashboard.**

```bash
autonomous-dev agent dashboard
```

Look for anomaly flags and declining approval rates.

**Step 2: Inspect a specific agent.**

```bash
autonomous-dev agent metrics <agent-name>
```

Review approval rate, average quality score, escalation rate, and token usage trends.

**Step 3: Check for active anomaly alerts.**

Anomalies are flagged when:
- Approval rate drops below 70% (configurable via `agents.anomaly_detection.approval_rate_threshold`)
- Escalation rate exceeds 30% (configurable via `agents.anomaly_detection.escalation_rate_threshold`)
- Quality score declines by 0.5 points over a 10-observation window

**Step 4: Review recent agent invocations.**

```bash
cat ~/.autonomous-dev/data/metrics/agent-invocations.jsonl | jq 'select(.agent == "<agent-name>")' | tail -10
```

### Resolution Steps

1. **Trigger improvement analysis:**
   ```bash
   autonomous-dev agent analyze <agent-name>
   ```
   This examines recent performance data, identifies weakness patterns, and generates a concrete improvement proposal.

2. **A/B test an improvement:**
   ```bash
   autonomous-dev agent compare <agent-name> --current 1.0.0 --candidate 1.1.0
   ```
   Runs both versions against historical inputs with blind scoring.

3. **Promote or reject:**
   ```bash
   autonomous-dev agent promote <agent-name> --version 1.1.0   # If candidate wins
   autonomous-dev agent reject <agent-name> --version 1.1.0    # If candidate loses
   ```

4. **Freeze a misbehaving agent (emergency):**
   ```bash
   autonomous-dev agent freeze <agent-name>
   ```
   The agent will be skipped during pipeline dispatch until unfrozen.

5. **Roll back to a previous version:**
   ```bash
   autonomous-dev agent rollback <agent-name> --to-version 0.9.0
   ```

### Prevention
- Monitor `autonomous-dev agent dashboard` regularly.
- Let the Agent Factory's automatic improvement cycle handle gradual degradation.
- Review and approve agent modifications promptly -- the system cannot self-improve without human approval.

---

## Scenario 7: Production Observation Failures

### Symptoms
- `/autonomous-dev:observe` produces errors or incomplete results
- Observation reports are missing data sources
- MCP connectivity errors in logs

### Diagnostic Steps

**Step 1: Check MCP connectivity.**

Verify environment variables are set:

```bash
echo $PROMETHEUS_URL
echo $GRAFANA_URL
echo $OPENSEARCH_URL
echo $SENTRY_URL
```

All four should return valid URLs.

**Step 2: Check MCP tokens.**

Verify tokens are set (do not print the actual values):

```bash
[ -n "$PROMETHEUS_TOKEN" ] && echo "PROMETHEUS_TOKEN is set" || echo "PROMETHEUS_TOKEN is NOT set"
[ -n "$GRAFANA_TOKEN" ] && echo "GRAFANA_TOKEN is set" || echo "GRAFANA_TOKEN is NOT set"
[ -n "$OPENSEARCH_TOKEN" ] && echo "OPENSEARCH_TOKEN is set" || echo "OPENSEARCH_TOKEN is NOT set"
[ -n "$SENTRY_TOKEN" ] && echo "SENTRY_TOKEN is set" || echo "SENTRY_TOKEN is NOT set"
```

**Step 3: Check for stale lock files.**

```bash
ls -la .autonomous-dev/observations/.lock-*
```

Stale locks from crashed runs prevent processing.

**Step 4: Check scrubbing errors.**

```bash
cat .autonomous-dev/logs/intelligence/RUN-*.log | grep -i "SCRUB_FAILED" | tail -10
```

If scrubbing fails, raw data is replaced with `[SCRUB_FAILED:...]` and never passed to the LLM.

**Step 5: Check observation run logs.**

```bash
ls -lt .autonomous-dev/logs/intelligence/ | head -5
cat .autonomous-dev/logs/intelligence/RUN-<latest>.log | tail -30
```

### Resolution Steps

1. **MCP source unavailable:** Partial data is OK. The run continues with whatever sources are reachable. Only when all sources are unreachable does the run abort. Fix the unreachable source's URL or token.
2. **Stale lock files:** Delete them:
   ```bash
   rm .autonomous-dev/observations/.lock-*
   ```
3. **Scrubbing failures:** Check if the source data format changed. Scrubbing is non-bypassable -- there is no `skip_scrubbing` flag.
4. **Token expired:** Regenerate a read-only token from the monitoring tool and update the environment variable.
5. **Run a manual observation to test:**
   ```
   /autonomous-dev:observe scope=<one-service>
   ```

### Prevention
- Use long-lived read-only tokens with minimal permissions.
- Set up monitoring for your monitoring tools (ironic but practical).
- Check observation logs after the first few scheduled runs to confirm everything works.

---

## Scenario 8: Merge Conflicts in Parallel Execution

### Symptoms
- Parallel tracks report merge conflicts
- Worktrees are left in a dirty state
- Integration phase fails

### Diagnostic Steps

**Step 1: Check worktree status.**

```bash
git worktree list
```

Look for worktrees created by autonomous-dev (they have names like `autonomous-dev-track-*`).

**Step 2: Check for dirty worktrees.**

```bash
for wt in $(git worktree list --porcelain | grep "worktree " | sed 's/worktree //'); do
  echo "=== $wt ==="
  git -C "$wt" status --short 2>/dev/null
done
```

**Step 3: Check parallel execution state.**

```bash
cat ~/.autonomous-dev/requests/REQ-XXXXXXXX-XXXX/state.json | jq '.parallel'
```

**Step 4: Check conflict resolution confidence.**

The system attempts AI-assisted merge conflict resolution. Check if the confidence threshold was met:

```bash
autonomous-dev config show | jq '.config.parallel.conflict_ai_confidence_threshold'
```

Default is 0.85. Conflicts below this confidence are escalated to a human.

### Resolution Steps

1. **Resolve conflicts manually in the worktree:**
   ```bash
   cd <worktree-path>
   git status
   # Fix conflicts in affected files
   git add <resolved-files>
   git commit -m "resolve merge conflicts"
   ```

2. **Clean up stuck worktrees:**
   ```bash
   git worktree remove <worktree-path> --force
   ```

3. **Lower AI confidence threshold (accept more auto-resolutions):**
   ```json
   {
     "parallel": {
       "conflict_ai_confidence_threshold": 0.75
     }
   }
   ```

4. **Reduce parallelism to minimize conflicts:**
   ```json
   {
     "parallel": {
       "max_tracks": 2,
       "max_worktrees": 3
     }
   }
   ```

5. **Force cleanup of all autonomous-dev worktrees:**
   ```bash
   autonomous-dev cleanup --force
   ```

### Prevention
- Keep parallel tracks working on independent files/modules when possible.
- Start with `max_tracks: 2` and increase only after confirming low conflict rates.
- Ensure tasks are well-decomposed so parallel tracks do not overlap.

---

## Scenario 9: Trust Level Confusion

### Symptoms
- Unexpected approval prompts (too many or too few)
- Unsure which trust level is active for a repo
- Trust promotion not working as expected

### Diagnostic Steps

**Step 1: Check effective trust level.**

```bash
autonomous-dev config show | jq '.config.trust'
```

This shows the `system_default_level` and any per-repository overrides.

**Step 2: Understand the gate matrix.**

| Gate | L0 | L1 | L2 | L3 |
|---|---|---|---|---|
| PRD approval | human | human | system | system |
| Code review | human | human | human | system |
| Test review | human | system | system | system |
| Deploy approval | human | human | human | system |
| Security review | human | human | human | human |
| Cost approval | human | human | system | system |
| Quality gate | human | system | system | system |

**Step 3: Check trust promotion settings.**

```bash
autonomous-dev config show | jq '.config.trust.promotion'
```

### Resolution Steps

1. **Too many approval prompts:** You are at a lower trust level than you want. Increase the level:
   ```json
   {
     "trust": {
       "repositories": {
         "/path/to/repo": { "default_level": 2 }
       }
     }
   }
   ```

2. **Too few approval prompts:** You want more oversight. Decrease the trust level:
   ```json
   {
     "trust": {
       "repositories": {
         "/path/to/repo": { "default_level": 0 }
       }
     }
   }
   ```

3. **Trust promotion not working:**
   - Check that `trust.promotion.enabled` is `true`.
   - Check that `min_consecutive_successes` has been met (default: 20).
   - Promotion always requires human approval (`require_human_approval: true` is immutable).

4. **Security review keeps prompting:** This is by design. Security review is always human-controlled at all trust levels. This cannot be overridden.

### Prevention
- Start at L0 for new repos and promote gradually.
- Set per-repo trust levels rather than changing the system default.
- Document your trust level strategy so you remember why each repo is at its current level.

---

## Scenario 10: Crash Recovery

### Symptoms
- Daemon has stopped unexpectedly
- Circuit breaker is tripped
- Requests are in an unknown state
- Heartbeat is stale

### Diagnostic Steps

**Step 1: Check daemon status.**

```bash
autonomous-dev daemon status
```

Look for `Circuit breaker: TRIPPED` and the crash count.

**Step 2: Check the heartbeat.**

```bash
autonomous-dev daemon status
```

If the last heartbeat is more than 2x the heartbeat interval (default: 30 seconds) ago, the daemon has crashed.

**Step 3: Check crash state.**

```bash
cat ~/.autonomous-dev/crash_state.json 2>/dev/null | jq '.'
```

**Step 4: Review daemon logs for the crash cause.**

```bash
# macOS
tail -100 ~/.autonomous-dev/logs/daemon.log | jq '.' 2>/dev/null || tail -100 ~/.autonomous-dev/logs/daemon.log

# Linux
journalctl --user -u autonomous-dev --no-pager -n 100
```

**Step 5: Check request checkpoint files.**

```bash
ls ~/.autonomous-dev/requests/*/state.json | while read f; do
  echo "=== $f ==="
  jq '{request_id: .request_id, phase: .current_phase, status: .status}' "$f"
done
```

### Resolution Steps

1. **Investigate the root cause.** Read the daemon logs carefully. Common crash causes:
   - Out-of-disk space
   - Configuration corruption
   - External dependency failure (claude CLI, git)
   - Lock file contention

2. **Validate configuration.**
   ```bash
   autonomous-dev config validate
   ```

3. **Reset the circuit breaker.**
   ```bash
   autonomous-dev circuit-breaker reset
   ```

4. **Restart the daemon.**
   ```bash
   autonomous-dev daemon start
   ```

5. **Check request state.** The daemon resumes from the last known checkpoint. Requests that were mid-phase will restart that phase from the beginning (not from the middle of a Claude session).

6. **Clean up if needed.**
   ```bash
   autonomous-dev cleanup --dry-run
   autonomous-dev cleanup
   ```

### Prevention
- Monitor disk space (default limit: 10 GB in `governance.disk_usage_limit_gb`).
- Keep `autonomous-dev config validate` in your routine.
- Check `autonomous-dev daemon status` after reboots.
- The daemon auto-restarts via launchd/systemd, but if `emergency.restart_requires_human` is `true` (default), it will not restart after an emergency stop without human intervention.

---

## Scenario 11: Rate Limiting

### Symptoms
- Claude API returning rate limit errors
- Phases taking much longer than expected
- Backoff messages in daemon logs

### Diagnostic Steps

**Step 1: Check daemon logs for rate limit errors.**

```bash
cat ~/.autonomous-dev/logs/daemon.log | jq 'select(.message | contains("rate_limit") or contains("429"))' 2>/dev/null | tail -10
```

**Step 2: Check backoff state.**

```bash
cat ~/.autonomous-dev/logs/daemon.log | jq 'select(.message | contains("backoff"))' 2>/dev/null | tail -10
```

**Step 3: Check rate limit configuration.**

```bash
autonomous-dev config show | jq '.config.governance.rate_limit_backoff_base_seconds, .config.governance.rate_limit_backoff_max_seconds'
```

Default: base 30 seconds, max 900 seconds (15 minutes).

**Step 4: Check concurrent request count.**

```bash
autonomous-dev config show | jq '.config.governance.max_concurrent_requests'
```

Default: 3. More concurrent requests means more API calls.

### Resolution Steps

1. **Reduce concurrency:**
   ```json
   {
     "governance": {
       "max_concurrent_requests": 1
     }
   }
   ```

2. **Adjust backoff settings:**
   ```json
   {
     "governance": {
       "rate_limit_backoff_base_seconds": 60,
       "rate_limit_backoff_max_seconds": 1800
     }
   }
   ```

3. **Wait it out.** Rate limits are typically time-based. The daemon's exponential backoff will automatically slow down and retry.

4. **Check your Anthropic API plan.** You may need a higher rate limit tier for heavy autonomous-dev usage.

### Prevention
- Start with `max_concurrent_requests: 1` and increase only if you have rate limit headroom.
- Schedule heavy workloads during off-peak hours.
- Monitor `autonomous-dev cost --daily` to understand your API usage patterns.

---

## Scenario 12: Intake Channel Issues

### Symptoms
- Discord bot not responding to messages
- Slack commands returning errors
- Requests submitted via Discord/Slack not appearing in the pipeline
- Authorization errors when submitting

### Diagnostic Steps

**Step 1: Check notification delivery configuration.**

```bash
autonomous-dev config show | jq '.config.notifications.delivery'
```

**Step 2: (Discord) Check bot status.**

Verify the Discord bot is online in your server. Check that:
- The bot has the `MESSAGE_CONTENT` intent enabled
- The bot has `Send Messages` and `Read Message History` permissions
- The webhook URL is valid

**Step 3: (Slack) Check app status.**

Verify the Slack app is installed and active. Check:
- The app manifest was deployed with the correct `${SLACK_HOST}` value
- Slash commands are registered (try `/ad-status` to test)
- The webhook URL is valid

**Step 4: Check intake rate limits.**

```bash
autonomous-dev config show | jq '.config.intake.rate_limits'
```

Default: 10 submissions per hour, 60 queries per minute.

**Step 5: Check intake logs.**

```bash
cat ~/.autonomous-dev/logs/intake.log | tail -30
```

**Step 6: Check authorization.**

```bash
# Check if the user/channel is authorized
cat ~/.autonomous-dev/intake/authz/*.json 2>/dev/null | jq '.'
```

### Resolution Steps

1. **Discord webhook invalid:** Regenerate the webhook in Discord server settings and update `notifications.delivery.discord.webhook_url`.

2. **Slack app not responding:**
   - Re-deploy the app manifest from `intake/adapters/slack/slack-app-manifest.yaml`
   - Verify `${SLACK_HOST}` was replaced with your actual hostname
   - Check that the Slack app has the required OAuth scopes

3. **Rate limited:** Intake has its own rate limits separate from API rate limits. Increase if needed:
   ```json
   {
     "intake": {
       "rate_limits": {
         "submissions_per_hour": 20,
         "queries_per_minute": 120
       }
     }
   }
   ```

4. **Authorization errors:** Check the authorization engine configuration. Users must be authorized to submit requests through external channels.

5. **Requests not appearing:** Check the queue depth:
   ```bash
   autonomous-dev config show | jq '.config.intake.max_queue_depth'
   ```
   Default is 50. If the queue is full, new submissions are rejected.

### Prevention
- Test intake channels after initial setup with a simple `/ad-status` (Slack) or a test message (Discord).
- Use long-lived webhook URLs.
- Monitor the intake log periodically.
- Set up notifications to confirm when requests are received by the pipeline.
