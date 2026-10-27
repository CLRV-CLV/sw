#!/usr/bin/env bash
# Safe in-place update. Never deletes the database, .env, or ignored user files.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BRANCH="arena/fd457726-sw"
RESTART="auto"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
usage() {
  cat <<'HELP'
Usage: ./update.sh [branch] [--restart auto|pm2|none]
Default branch: arena/fd457726-sw
  auto: restart existing PM2 process sw-interknot if found; otherwise print manual restart instructions.
  pm2: require that existing PM2 process; fail preflight if not found.
  none: build only; restart with BaoTa's Node project manager afterwards.
Environment: BACKUP_DIR (default ./backups), PM2_APP_NAME (default sw-interknot).
Requires Node >=22.16, npm, git, flock. Local changes are never overwritten.
HELP
}
while (($#)); do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --restart) [[ $# -ge 2 ]] || { usage; exit 2; }; RESTART="$2"; shift 2 ;;
    --*) echo "Unknown option: $1" >&2; exit 2 ;;
    *) BRANCH="$1"; shift ;;
  esac
done
[[ "$RESTART" =~ ^(auto|pm2|none)$ ]] || { usage; exit 2; }
cd "$ROOT"
for cmd in git node npm flock; do command -v "$cmd" >/dev/null || { echo "Missing command: $cmd" >&2; exit 1; }; done
node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<16)){console.error("Node >=22.16 required");process.exit(1)}'
git check-ref-format --branch "$BRANCH" >/dev/null
exec 9>"$ROOT/.update.lock"
flock -n 9 || { echo 'Another update is running.' >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] || { echo 'Working tree has local changes. Commit/review them first; update refused (no files overwritten).' >&2; exit 1; }
APP="${PM2_APP_NAME:-sw-interknot}"
HAS_PM2=0
if command -v pm2 >/dev/null && pm2 describe "$APP" >/dev/null 2>&1; then HAS_PM2=1; fi
if [[ "$RESTART" == pm2 && "$HAS_PM2" == 0 ]]; then echo "PM2 app $APP not found. Use BaoTa restart or --restart none." >&2; exit 1; fi
# Resolve .env exactly like npm start, using Node's parser (never source shell code).
DATA_PATH="$(cd "$ROOT/server" && node --env-file-if-exists=../.env --input-type=module -e 'import path from "node:path";process.stdout.write(path.resolve(process.env.DATA_DIR || "./data"))')"
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
BACKUP="$BACKUP_DIR/$STAMP"
mkdir -m 700 "$BACKUP"
export SW_DATA_PATH="$DATA_PATH" SW_BACKUP_PATH="$BACKUP"
# Online SQLite backup includes WAL transactions; copying only .sqlite is unsafe.
node --input-type=module <<'JS'
import { existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';
import path from 'node:path';
const dest=process.env.SW_BACKUP_PATH;
const dbFile=path.join(process.env.SW_DATA_PATH,'interknot.sqlite');
if(existsSync(dbFile)) {
  const db=new DatabaseSync(dbFile,{readOnly:true});
  try { await backup(db,path.join(dest,'interknot.sqlite')); } finally { db.close(); }
}
if(existsSync('.env')) copyFileSync('.env',path.join(dest,'.env'));
writeFileSync(path.join(dest,'metadata.json'),JSON.stringify({dataDir:process.env.SW_DATA_PATH,date:new Date().toISOString()},null,2));
JS
chmod -R go-rwx "$BACKUP"
git rev-parse HEAD > "$BACKUP/commit.txt"
echo "Backup saved: $BACKUP (contains private data; do not expose via nginx)"
# Fetch the explicitly selected remote branch and require a fast-forward.
# No checkout/reset/clean/stash: database, local files and current branch identity survive.
git fetch origin "refs/heads/$BRANCH"
OLD="$(git rev-parse HEAD)"
TARGET="$(git rev-parse FETCH_HEAD)"
git merge-base --is-ancestor "$OLD" "$TARGET" || { echo 'Target is not a fast-forward. Resolve branch divergence manually; no forced reset performed.' >&2; exit 1; }
# Inspect the target BEFORE merge so it cannot overwrite ignored private files.
if [[ "$DATA_PATH" == "$ROOT"/* ]]; then
  REL="${DATA_PATH#"$ROOT/"}"
  [[ -z "$(git ls-tree -r --name-only "$TARGET" -- "$REL")" ]] || { echo 'Target tracks the data directory; refused before merge.' >&2; exit 1; }
fi
[[ -z "$(git ls-tree -r --name-only "$TARGET" -- .env backups)" ]] || { echo 'Target tracks private config/backups; refused before merge.' >&2; exit 1; }
git merge --ff-only "$TARGET"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
npm ci --prefix server --registry="$NPM_REGISTRY"
npm ci --prefix web --include=dev --registry="$NPM_REGISTRY"
npm run build:web --prefix server
if [[ "$RESTART" != none && "$HAS_PM2" == 1 ]]; then
  pm2 restart "$APP" --update-env
  echo "Updated and restarted $APP. Verify your domain and /health."
else
  echo 'Build complete. Restart this project in BaoTa Node project manager (do not start a second process on port 3000).'
fi
echo "Updated $OLD -> $(git rev-parse HEAD), source branch: $BRANCH"
echo 'Database preserved. Backup contains DB/.env only; back up any custom media directories separately.'
