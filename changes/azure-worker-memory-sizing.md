- Increased the Azure worker container's CPU and memory allowance across all size profiles. PowerShell Graph crawlers spawn one runspace per parallel task via `ForEach-Object -Parallel`, and each runspace duplicates the session state — memory pressure scales fast on real tenants. The previous tiers maxed out at 0.5 CPU / 1 GB memory even on `xl`, which OOM-killed real customer syncs (4.5K users + 9.9K groups + 3.6K service principals — a mid-size tenant). New sizing keeps the same Postgres / App Service tiering but bumps the worker substantially:

  | Profile | Web SKU | Worker (was → now) |
  |---|---|---|
  | xs | B1 | 0.25 CPU / 0.5Gi → **0.5 CPU / 1Gi** |
  | s (default) | B2 | 0.25 CPU / 0.5Gi → **1 CPU / 2Gi** |
  | m | S1 | 0.25 CPU / 0.5Gi → **1 CPU / 2Gi** |
  | l | P1v3 | 0.5 CPU / 1Gi → **2 CPU / 4Gi** |
  | xl | P2v3 | 0.5 CPU / 1Gi → **2 CPU / 4Gi** |

  Marginal cost is small (~€5-15/month per tier) compared with the cost of debugging an OOM crash halfway through a customer's first sync. Existing deployments aren't affected automatically; redeploy or run `az containerapp update --name <worker> --resource-group <rg> --cpu 2.0 --memory 4.0Gi` to bump an existing worker.
