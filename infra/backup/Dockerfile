# Scheduled encrypted PostgreSQL backups (spec 18/24). Runs infra/scripts/backup.sh daily; records runs in backup_runs.
FROM postgres:16-alpine
RUN apk add --no-cache bash openssl coreutils tzdata
COPY scripts/backup.sh /usr/local/bin/backup.sh
COPY backup/loop.sh /usr/local/bin/loop.sh
# tolerate CRLF checkouts on Windows
RUN sed -i 's/\r$//' /usr/local/bin/*.sh && chmod +x /usr/local/bin/*.sh
ENTRYPOINT ["/bin/bash", "/usr/local/bin/loop.sh"]
