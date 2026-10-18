# Concurrency under real PostgreSQL

Generated 2026-10-18T02:13:51.134Z by `npm run evaluate:security:concurrency` at commit `61de49007640` with uncommitted changes. PostgreSQL 16.14 (Debian 16.14-1.pgdg12+1) (pgvector/pgvector:pg16) in a local Docker container, read committed; 25 parallel requests per round, 20 rounds; Node v24.16.0.

SEC-E2E-01 and 03 test these races against PGlite, which runs one statement at a time. Here the platform's own code runs against a PostgreSQL server through a connection pool, so simultaneous requests are simultaneous transactions. Only the session, GitHub dispatch and the tenant's signer and backend are replaced.

**Overall: PASS.** Secrets searched for in the evidence: 5 plus 8 credential patterns; none found.

| | Scenario | Required | Observed | Held |
|---|---|---|---|---|
| attack | 25 parallel redeploys × 20 rounds | every round: one dispatched, the rest refused as in progress, one active row | `{"rounds":20,"parallel":25,"roundsBroken":0,"refusedAsInProgress":480,"otherErrors":[]}` | ✓ |
| control | The same race without the index (negative control) | duplicates appear, showing the index is what prevents them | `{"activeRowsPerRound":[25,25,25,25,25]}` | ✓ |
| attack | 25 parallel terminal callbacks × 20 rounds | every round: exactly one callback applied | `{"roundsBroken":0,"stoppedByAtomicWrite":479,"stoppedByReadCheck":1,"roundsWithOverlap":20}` | ✓ |
| attack | 25 parallel secrets claims × 20 rounds | every round: secrets released to exactly one run, which the row names | `{"roundsBroken":0,"releasedPerRound":[1]}` | ✓ |
| attack | 25 parallel cross-tenant redeploys beside the owner's × 20 rounds | every round: all attacker requests refused, the owner's one deployment dispatched | `{"roundsBroken":0}` | ✓ |
| control | The owner's own redeploy during the burst | succeeds every round | `{"ownerSucceededRounds":20,"rounds":20}` | ✓ |

*stoppedByAtomicWrite* counts callbacks that passed the route's read check and were refused only by the conditional UPDATE, after waiting for the winner's row lock; it is the direct measure that the requests overlapped. The negative control drops the unique index and repeats the redeploy race.
