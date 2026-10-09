import { ConflictException } from '@nestjs/common';
import { IntegrationState } from '../../generated/prisma/enums';

// A GitHub App uninstalled or suspended on GitHub's side (the `installation`
// webhook) can no longer mint installation tokens. Every call that needs
// one says so up front instead of failing as a generic installation_invalid
// — the fix is in Settings → Integrations (reinstall, unsuspend, or
// disconnect), and the FE needs to know which.
export function assertGithubAccess(integration: {
  state: IntegrationState;
}): void {
  if (integration.state === IntegrationState.UNINSTALLED) {
    throw new ConflictException({
      field: 'organizationId',
      message: 'github_uninstalled',
    });
  }
  if (integration.state === IntegrationState.SUSPENDED) {
    throw new ConflictException({
      field: 'organizationId',
      message: 'github_suspended',
    });
  }
}
