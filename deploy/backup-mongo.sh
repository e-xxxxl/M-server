#!/usr/bin/env bash
# Daily backup of the NMREP database. Installed as /usr/local/bin/nmrep-backup and run by cron (see DEPLOY-VPS.md).
#
# It writes one compressed file per run to /var/backups/nmrep and deletes backups older than 14 days.
# The database login is read from /etc/nmrep/mongodump.yaml (readable by root only), never from the command line,
# so the password does not appear in the process list.
#
# A backup that stays on the same server does not protect you from losing the server. Copy the files somewhere
# else as well (see the OFF-SERVER COPY section at the end of this file).
set -euo pipefail

DEST=/var/backups/nmrep
KEEP_DAYS=14
CONFIG=/etc/nmrep/mongodump.yaml
STAMP="$(date +%Y-%m-%d-%H%M)"
FILE="$DEST/nmrep-$STAMP.archive.gz"

[[ -r "$CONFIG" ]] || { echo "Missing $CONFIG"; exit 1; }
mkdir -p "$DEST"
chmod 700 "$DEST"

mongodump --config="$CONFIG" --archive="$FILE.part" --gzip --quiet
mv "$FILE.part" "$FILE"
chmod 600 "$FILE"

# A file that is suspiciously small means the dump failed quietly.
SIZE="$(stat -c %s "$FILE")"
if [[ "$SIZE" -lt 1000 ]]; then echo "Backup $FILE is only $SIZE bytes. Check the database login."; exit 1; fi

find "$DEST" -name 'nmrep-*.archive.gz' -mtime +"$KEEP_DAYS" -delete
echo "Backup written: $FILE ($SIZE bytes)"

# ------------------------------------------------------------------------------------------------
# OFF-SERVER COPY. Choose one, uncomment it and fill in the details. Test it by running this script by hand.
#
# 1) To another Linux server over SSH (create a key without a passphrase on this server, dedicated to this job):
#    scp -i /root/.ssh/nmrep_backup_key -o StrictHostKeyChecking=yes "$FILE" backupuser@other-server:/backups/nmrep/
#
# 2) To an S3 compatible bucket with rclone (apt install rclone; rclone config):
#    rclone copy "$FILE" remote:nmrep-backups --quiet
# ------------------------------------------------------------------------------------------------
