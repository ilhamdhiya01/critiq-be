import { Provider, Role } from '../../../generated/prisma/enums';

// Response shape for GET /auth/me — deliberately distinct from JwtPayload.
// The token only ever carries `sub` plus session-scoped fields (activeOrgId,
// role, onboardingCompleted); profile fields (email, name, avatarUrl) are
// always read fresh from the User row here, never embedded in the token
// itself — same reasoning CLAUDE.md gives for re-verifying role/activeOrgId
// from DB rather than trusting the payload: a token can't be revoked or
// updated mid-lifetime, so anything that can change (a user's name, their
// email) must not be baked into it.
export class SessionUserDto {
  id!: string;
  email!: string;
  name!: string | null;
  avatarUrl!: string | null;
  activeOrgId!: string | null;
  role!: Role | null;
  provider!: Provider;
  onboardingCompleted!: boolean;

  constructor(partial: {
    id: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    activeOrgId: string | null;
    role: Role | null;
    provider: Provider;
    onboardingCompleted: boolean;
  }) {
    Object.assign(this, partial);
  }
}
