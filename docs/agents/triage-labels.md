# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |
| `in-progress` (ours)       | `in-progress`        | Claimed: someone is working on it right now |

`in-progress` is not a triage role, it is the claim marker two agents share. Before starting work on a
ticket, add the label and comment which session claimed it:

```bash
gh issue edit <n> --add-label in-progress
gh issue comment <n> -b "认领：<session name>"
```

Check `gh issue list --label in-progress` first so two sessions never take the same ticket. Close the
ticket (or drop the label) when the work is delivered or abandoned — a stale `in-progress` hides real
remaining work.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.

## Acceptance only a human can give

A ticket whose acceptance needs a human ear or a human eye — half-duplex echo, per-player read-aloud,
overlay readability, hold-to-talk detection — must never be closed by the implementer. Probe-green is not
ear-pass. Mark it `ready-for-human`, hand it to the test session, and let the person who actually hears it
close it. Decision-level probes may settle the rest of such a ticket in the same pass.

## Two environment facts worth writing down

- `gh`'s GraphQL calls (comment, close) fail with a TLS timeout on this machine about half the time; the
  REST form is stable: `gh api -X POST repos/<owner>/<repo>/issues/<n>/comments -F body=@file` and
  `gh api -X PATCH repos/<owner>/<repo>/issues/<n> -f state=closed`.
- A git worktree under `.dev-flow/` has no `node_modules`; give it a junction before running typecheck,
  lint, build or a probe, or every gate fails for a reason that has nothing to do with the change.
