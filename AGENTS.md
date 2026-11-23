# Agents

This repository's review rule lives here, in [Pull request reviews](#pull-request-reviews). Everything
else about how to work in it is in the README, the workflows, and the code.

## Pull request reviews

`pi-review` reviews every pull request. It checks out the merge commit, installs, and runs the code, so it
takes minutes rather than seconds. Its check is the **`review / review`** row of `gh pr checks`.

**Do not push while `pi-review` is reading.** The `pi-review` workflow cancels its own superseded run, so a push cancels the review in flight, and a cancelled run has already
read most of the pull request and spent most of what it was going to spend. Pushing to be fast is the
expensive choice, not the cheap one.

Read the `review / review` row and act on the state it reports:

| `review / review` on this head                   | What to do                                                                                                     |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| pending                                          | **Wait. Do not push.** A push cancels it and the wait starts over.                                              |
| skipped                                          | A draft, or a branch that is not in this repository. A draft can be marked ready; a fork is never reviewed.      |
| a review for this head                           | Push **once**, with every finding from it. One push per finding restarts the cycle and pays for the read again.  |
| failed, or cancelled by a push that was not yours | It will not post for this head. Say so on the thread, then push.                                               |
| still pending, and it has no start time | The run is queued for a runner, not late. GitHub enforces the 33-minute job timeout itself, so a job that is *running* cannot sit past it — it ends cancelled or failed, which is the row above. A run with no start (`gh run view <id> --json status,startedAt`) is waiting and will start, so wait. |

A green `review / review` tick means a review was posted — the job exits non-zero when it cannot post — so
read the review rather than trusting the tick. A red check from CI is the one exception to all of the
above: fix it and push.
