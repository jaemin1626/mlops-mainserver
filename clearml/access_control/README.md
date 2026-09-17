# Access control service

SQLite-backed accounts, sessions, permissions, labeling tasks and audit history for the existing MLOps stack.

## Initial administrator

Run once after the service is deployed:

```bash
docker exec clearml-access-control python /app/manage.py create-admin \
  --username admin --name "Intellivix Admin" --password '<temporary-password-at-least-10-characters>'
```

Open `/access-login.html`. The initial administrator and newly created accounts must replace the temporary password after their first login.

## Permissions

- `TRAIN_DEPLOY`: training and deployment mutations
- `DATA_GENERATE`: Video Studio mutations
- `LABEL_WORK`: assigned labeling work
- `LABEL_REVIEW`: assigned review work

The Admin page is available only to accounts with `is_admin=true`. API checks remain authoritative even when a UI control is hidden or disabled.
