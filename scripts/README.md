# Live API smoke checks

Run `npx tsx scripts/live-smoke.ts` for the full suite or add `--recovery-only` for the recovery checks. Credentials come from `TYPESAFE_API_KEY` or the macOS `jevctl` keychain item; they are never printed. Tests use temporary login storage, real Pi extension dispatch and real Jev requests. User-message delivery is captured by the harness: no main-model run, proposed shell command, deployment, or destructive action is executed.

`live-smoke-results.json` retains the previous full-suite run with its original timestamp. `live-recovery-results.json` is the latest dedicated recovery run. The observation reports retain earlier failures: the 2.5-second timeout, a compound prompt rejecting benign continuation, and a conservative user-dependency threshold. Recovery now uses a separate 10-second minimum request budget and two narrow judgments, with initial thresholds 0.9 / 0.2. These fixtures do not establish broad calibration or production reliability.

Timers and cancellation, duplicate events, policy blocks, user cancellation, queue checks, persistence and attempt limits are additionally covered by the offline test suite (`npm run check`).
