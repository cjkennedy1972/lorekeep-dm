# Adventure resume 182 reliability fix

Base: `43477b2e995214b324b5bb90687b12ad1eca0e50` (`fix/flaky-tests-17f41380`).

## Failure and diagnosis

The Adventure-resume failure was reproduced at the gateway boundary: `ADVANCE-8` was rejected before it could be handled; the action narration stream therefore ended at `ADVANCE-7`. The corresponding prior trace showed ingress rejection, not a narration completion race or a WebSocket reconnect failure. The observed Vite proxy ECONNRESET messages were not present in the earlier independent failure probe and are treated as incidental unless reproduced again.

Fix: keep the ordinary player-action token bucket at 20 tokens, but give protocol synchronization reads (`Resync`, `ChatHistoryRequest`) a separate bounded 40-token bucket. A scene action triggers these sync reads; charging them to the action budget allowed protocol traffic to consume the budget needed by the final advance. The Adventure live test server is also explicitly limited to one Vitest worker to avoid spawning workers for every reported CPU.

## Verification log

All runs are sequential, single-worker, with no load generation. Runs 01 and 02 were confirmed green before the gateway restart (source: retained Forge session transcript); the third standalone green immediately before the loop was a harness check and is not counted toward this streak.

| Run | Result | Notes |
|---:|---|---|
| 01 | PASS | retained output: 1 passed (5.1s) |
| 02 | PASS | retained output: 1 passed (5.4s) |


### Run 03

Running 1 test using 1 worker

  ✓  1 [chromium] › e2e-adventure/adventure-resume.spec.ts:183:1 › keyboard-only Adventure #1 starts through the solo flow, restarts mid-scene, resumes, and completes (4.1s)

  1 passed (4.9s)
Exit status: 0

### Run 04

Running 1 test using 1 worker

  ✓  1 [chromium] › e2e-adventure/adventure-resume.spec.ts:183:1 › keyboard-only Adventure #1 starts through the solo flow, restarts mid-scene, resumes, and completes (4.1s)

  1 passed (4.9s)
Exit status: 0

### Run 05

Running 1 test using 1 worker

  ✓  1 [chromium] › e2e-adventure/adventure-resume.spec.ts:183:1 › keyboard-only Adventure #1 starts through the solo flow, restarts mid-scene, resumes, and completes (4.5s)

  1 passed (5.2s)
Exit status: 0

### Run 06

Running 1 test using 1 worker

  ✓  1 [chromium] › e2e-adventure/adventure-resume.spec.ts:183:1 › keyboard-only Adventure #1 starts through the solo flow, restarts mid-scene, resumes, and completes (4.7s)

  1 passed (5.4s)
Exit status: 0

### Run 07

Running 1 test using 1 worker

  ✓  1 [chromium] › e2e-adventure/adventure-resume.spec.ts:183:1 › keyboard-only Adventure #1 starts through the solo flow, restarts mid-scene, resumes, and completes (4.7s)

  1 passed (5.5s)
Exit status: 0

### Run 08

Running 1 test using 1 worker

  ✓  1 [chromium] › e2e-adventure/adventure-resume.spec.ts:183:1 › keyboard-only Adventure #1 starts through the solo flow, restarts mid-scene, resumes, and completes (5.1s)

  1 passed (5.9s)
Exit status: 0

### Run 09

Running 1 test using 1 worker

  ✓  1 [chromium] › e2e-adventure/adventure-resume.spec.ts:183:1 › keyboard-only Adventure #1 starts through the solo flow, restarts mid-scene, resumes, and completes (6.5s)

  1 passed (7.5s)
Exit status: 0

### Run 10

Running 1 test using 1 worker

  ✓  1 [chromium] › e2e-adventure/adventure-resume.spec.ts:183:1 › keyboard-only Adventure #1 starts through the solo flow, restarts mid-scene, resumes, and completes (18.9s)

  1 passed (20.5s)
Exit status: 0

### Run 11

Running 1 test using 1 worker


Cleanup investigation: the first harness change forced `--pool=threads`; a lifecycle-validation run then failed on restart with `Room lease unavailable`. That run is excluded from the green streak. This showed the long-lived fixture requires Vitest's fork worker to receive graceful shutdown; the cleanup now signals the Vitest parent (which can shut down its worker) rather than indiscriminately signaling its detached process group. The thread-pool experiment was reverted.

Run 11 was interrupted during fixture lifecycle validation and left port 8799 occupied. Runs 12 and 13 reproduced that same harness cleanup failure (EADDRINUSE), not the original gateway symptom; their captured outputs are retained in the adjacent run logs. The fixture now records its Vitest worker PID, signals it during teardown, and reaps it after a bounded grace period.

| Run | Result | Notes |
|---:|---|---|
| 12 | FAIL (harness) | Port 8799 was held by an orphaned fixture worker; see adventure-resume-182-run-12.log. |
| 13 | FAIL (harness) | Same orphaned-worker condition before PID-aware cleanup; see adventure-resume-182-run-13.log. |
| 14 | PASS | 1 passed (4.8s); see adventure-resume-182-run-14.log. |
| 15 | PASS | 1 passed (5.1s); see adventure-resume-182-run-15.log. |
| 16 | PASS | 1 passed (10.9s); no fixture process or listener remained; see adventure-resume-182-run-16.log. |

Final checks: gateway WebSocket test file passed (7 tests); server typecheck passed; ESLint and Prettier checks passed for all changed TypeScript files; git diff --check passed.
