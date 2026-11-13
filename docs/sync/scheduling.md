# Schedule and run crawlers

Every crawler that pulls data — Entra ID, Azure Resource Manager, Omada, midPoint, SQL Database and SCIM — is scheduled and started the same way. This page describes that once; each connector page only adds what is specific to its source.

Two crawler types have no schedule: **CSV Import** runs when you start it, and a **Custom Connector** pushes data whenever your own process decides to.

---

## Run a crawler by hand

Go to **Admin → Crawlers**. Each crawler you added is a card with these buttons:

| Button | What it does |
|---|---|
| **Run Delta** | Queues a delta run: read only what changed since the last successful run. |
| **Run Full** | Queues a full run: read everything again. |
| **Force Stop** | Replaces the two run buttons while a run is queued or running. Stops that run. |
| **Configure** | Reopens the wizard with the saved settings. |
| **Export** | Downloads the crawler's settings as a JSON file, without its secret. |
| **Remove** | Removes the crawler. |

The **Recent Jobs** table below the cards shows each run with its mode (`full` or `delta`).

---

## Add a schedule

The last step of each wizard is **Schedule**. Click **+ Add Schedule** to add an entry, and add as many as you need — a common setup is a frequent delta plus one full run a day. A crawler with no schedule only runs when you click a run button.

| Field | Choices |
|---|---|
| **Frequency** | **Every few minutes**, **Hourly**, **Daily** or **Weekly** |
| **Every** | For *Every few minutes*: 5, 10, 15, 20 or 30 minutes |
| **Hour (UTC)** | For *Daily* and *Weekly*: the hour of the day |
| **Minute** | For *Hourly*, *Daily* and *Weekly*: `:00`, `:15`, `:30` or `:45` |
| **Day** | For *Weekly*: the day of the week |
| **Mode** | **Delta (fast)** or **Full (authoritative)** |

All times are **UTC**. An *Every few minutes* schedule runs on the clock: every 15 minutes means `:00`, `:15`, `:30` and `:45`.

To change a schedule later, click **Configure** on the crawler's card and go to the **Schedule** step.

---

## Delta or full

| Mode | Reads | Removes what the source no longer has |
|---|---|---|
| **Full** | Everything you selected in the wizard | Yes |
| **Delta** | Only what changed, where the source can report that | Depends on the crawler |

Not every source can report changes. What a delta run does for each crawler:

| Crawler | A delta run… |
|---|---|
| Entra ID | reads changed users, service principals, groups and direct memberships. Everything else waits for the next full run — see [Connect Entra ID](entra-id.md#schedule-and-refresh). |
| SQL Database | depends on how each query is set up — see [SQL Server](mssql.md). |
| Azure Resource Manager, midPoint | reads everything, but removes nothing. |
| Omada, SCIM | runs as a full run. |

When in doubt, schedule at least one **Full** run a day.

---

## When two runs collide

A crawler runs one job at a time.

- If an *Every few minutes* run comes due while the crawler is still busy, that occurrence is skipped. The next one runs as usual.
- If an *Hourly*, *Daily* or *Weekly* run comes due while the crawler is busy, it waits and starts as soon as the crawler is free, for up to an hour. A daily full run is therefore not lost because a short delta happened to be running.

---

## What a full run removes

A full run compares what it just read with what the same crawler loaded before. Anything the source no longer has is removed from Identity Atlas. The comparison is limited to the crawler's own system, so one crawler never removes another crawler's data.

Removed accounts, resources and assignments are not erased at once: they are marked as deleted, kept for a retention period, and come back if the source shows them again. See [Soft-delete](../architecture/soft-delete.md).

---

## A crawler type is missing from Add Crawler

The **Add Crawler** list is built from the crawler definitions the web container finds at startup. In the Docker image they are in `/app/crawlers`. If you run the web container with your own setup, the `CRAWLER_MANIFESTS_DIR` environment variable must point to the folder that holds them — see [Docker setup](../architecture/docker-setup.md).

Crawler types marked **Experimental** are listed only while **Experimental crawlers** is turned on under **Admin → Experimental**. A crawler you already added keeps running when that is turned off.
