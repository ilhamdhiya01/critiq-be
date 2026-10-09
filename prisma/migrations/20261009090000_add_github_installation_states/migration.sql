-- GitHub App `installation` webhook: the App was uninstalled or suspended on
-- GitHub's side. The integration row is kept (reinstall restores it).
ALTER TYPE "IntegrationState" ADD VALUE 'UNINSTALLED';
ALTER TYPE "IntegrationState" ADD VALUE 'SUSPENDED';
