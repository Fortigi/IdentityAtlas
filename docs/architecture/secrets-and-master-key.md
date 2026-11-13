# Secrets and the Master Key

Identity Atlas stores the secrets it needs in its own database, encrypted: crawler credentials, the LLM API key and the credentials for pages a risk profile reads. This page explains how that vault works, where its master key lives, and what an operator does to back it up and rotate it.

## What the vault holds

| Secret | Stored when |
|---|---|
| Crawler credentials (client secrets, passwords) | A crawler is saved in Admin → Crawlers |
| The LLM API key | Admin → LLM Settings is saved |
| Scraper credentials | A risk profile source needs a password or token |

Each secret belongs to a scope (for example `llm` or `scraper`). Every read, existence check and delete names the scope it may touch, so a row in another scope is treated as absent.

## How a secret is encrypted

The vault uses envelope encryption with AES-256-GCM:

- Each row has its own random 32-byte **data key**. The secret value is encrypted with that key.
- The data key is encrypted ("wrapped") with the **master key**.
- Both layers bind the row's id and scope as additional authenticated data. A ciphertext copied onto another row does not decrypt. Rows written before this binding existed are re-bound automatically at startup.

Why this shape: one compromised data key exposes one secret, not all of them; rotating the master key only re-wraps the small data keys, never the values; and the same shape works with a hardware key store later, by swapping only the wrapping step.

The rows live in the `Secrets` table, created by [`010_secrets_and_risk.sql`](https://github.com/Fortigi/IdentityAtlas/blob/main/app/api/src/db/migrations/010_secrets_and_risk.sql): `id`, `scope`, `label`, the encrypted value (`ciphertext`, `iv`, `authTag`) and the wrapped data key (`encryptedKey`, `keyIv`, `keyAuthTag`).

## Where the master key comes from

At startup the web container looks for the master key in this order:

1. **`IDENTITY_ATLAS_MASTER_KEY`**, the environment variable, or `IDENTITY_ATLAS_MASTER_KEY_FILE` pointing at a file that holds it. This is the recommended choice for production: you control the key and back it up with your other root secrets. The Azure template reads it from Key Vault.
2. **A key file.** The path is `MASTER_KEY_FILE` when set, otherwise `$IDENTITY_ATLAS_KEY_DIR/.master-key`, otherwise `/data/uploads/.master-key`. The compose files set `IDENTITY_ATLAS_KEY_DIR=/data/keys`: the `web_keys` volume, which only the web container mounts.
3. **A new key**, generated on first start and written to the key file from step 2.

Two safeguards apply:

- A new key is **never generated while the vault already holds secrets**: it could not decrypt them. The container logs how many secrets it found and asks you to restore the key. To give up the stored secrets and start with a new key, set `IDENTITY_ATLAS_ALLOW_NEW_MASTER_KEY=true`.
- When a key is found at the old location `/data/uploads/.master-key` and `IDENTITY_ATLAS_KEY_DIR` is set, the key is moved to the key directory. It is copied, read back, checked against a stored secret, and only then removed from the old location. If any step fails, the key stays where it was. The old location is on the volume the worker also mounts, which is why the key moves.

If a generated key cannot be written, the container's startup work stops with a logged error instead of running with a key that would be lost on the next restart.

To generate a key yourself: `openssl rand -base64 32`, or `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. The key must decode to exactly 32 bytes.

## Backups

Back up the database **and** the master key. Without the key, every secret in the vault is unrecoverable. Depending on how the key was set, that means one of:

- the value of `IDENTITY_ATLAS_MASTER_KEY` (or the file `IDENTITY_ATLAS_MASTER_KEY_FILE` points at);
- the key file `/data/keys/.master-key` in the `web_keys` volume;
- the key file `/data/uploads/.master-key` in the `job_data` volume, with an older compose file.

## Rotating the master key

Use the `rotate-master-key` command. It re-wraps each row's data key from the previous master key to the new one, all rows in one transaction. It never decrypts a secret value and never prints one: the output is row counts, plus the ids of any rows that neither key opens. If such rows exist, nothing is written.

Both keys come from environment variables, never from command-line arguments:

| Variable | Value |
|---|---|
| `IDENTITY_ATLAS_MASTER_KEY_PREVIOUS` | The key the vault is encrypted with today: the current variable value, or the contents of the key file |
| `IDENTITY_ATLAS_MASTER_KEY` | The new key |

```bash
# 1. Stop the containers that use the vault, so nothing writes with the old key
docker compose stop web worker

# 2. Put both keys in your shell environment without echoing them
#    (read -s keeps them out of shell history)
read -rs IDENTITY_ATLAS_MASTER_KEY_PREVIOUS && export IDENTITY_ATLAS_MASTER_KEY_PREVIOUS
read -rs IDENTITY_ATLAS_MASTER_KEY && export IDENTITY_ATLAS_MASTER_KEY

# 3. Dry run, then the real rotation. `-e NAME` without a value passes the
#    variable through from your shell.
docker compose run --rm --no-deps   -e IDENTITY_ATLAS_MASTER_KEY_PREVIOUS -e IDENTITY_ATLAS_MASTER_KEY   web node /app/backend/src/cli/rotate-master-key.js --dry-run
docker compose run --rm --no-deps   -e IDENTITY_ATLAS_MASTER_KEY_PREVIOUS -e IDENTITY_ATLAS_MASTER_KEY   web node /app/backend/src/cli/rotate-master-key.js

# 4. Point the web container at the new key: set IDENTITY_ATLAS_MASTER_KEY in
#    your compose env or secret store, or (generated key) replace the contents
#    of the key file. Then start the stack again.
docker compose up -d
```

The rotation can be repeated safely: rows already wrapped by the new key are skipped, so an interrupted run can simply be run again. Keep the previous key until the web container has started cleanly on the new one.

## Related

- [Configuration → Secrets vault](../reference/config.md#secrets-vault) lists every variable on this page with its default.
- [LLM & Risk Scoring Internals](llm-and-risk-scoring.md) describes the features that store their keys here.
