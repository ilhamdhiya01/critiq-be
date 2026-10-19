import { Transform } from 'class-transformer';
import { IsEmail, IsIn, MaxLength } from 'class-validator';
import type {
  Invitation,
  InvitationEmailStatus,
  Role,
  User,
} from '../../../generated/prisma/client';

export type WireRole = 'admin' | 'reviewer' | 'viewer';
const WIRE_ROLES: WireRole[] = ['admin', 'reviewer', 'viewer'];

export const toRole = (role: WireRole): Role => role.toUpperCase() as Role;
export const toWireRole = (role: Role): WireRole =>
  role.toLowerCase() as WireRole;

export class CreateInviteDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsIn(WIRE_ROLES)
  role!: WireRole;
}

export class UpdateMemberRoleDto {
  @IsIn(WIRE_ROLES)
  role!: WireRole;
}

export class MemberDto {
  userId!: string;
  name!: string;
  email!: string;
  avatarUrl!: string | null;
  role!: WireRole;
  joinedAt!: Date;
  isYou!: boolean;

  constructor(partial: MemberDto) {
    Object.assign(this, partial);
  }
}

export class InviteDto {
  id!: string;
  email!: string;
  role!: WireRole;
  invitedBy!: { id: string; name: string } | null;
  createdAt!: Date;
  expiresAt!: Date;
  delivery!: {
    status: 'pending' | 'sent' | 'failed' | 'not_configured';
    error: string | null;
  };

  constructor(partial: InviteDto) {
    Object.assign(this, partial);
  }
}

export class MembersListDto {
  members!: MemberDto[];
  // Null for anyone but an Admin.
  invites!: InviteDto[] | null;

  constructor(partial: MembersListDto) {
    Object.assign(this, partial);
  }
}

// The link is in this response only — it cannot be shown again (only its
// hash is stored).
export class InviteCreatedDto {
  invite!: InviteDto;
  inviteUrl!: string;

  constructor(partial: InviteCreatedDto) {
    Object.assign(this, partial);
  }
}

export type InviteStatus = 'pending' | 'expired' | 'revoked' | 'accepted';

export class InvitePreviewDto {
  organization!: { name: string; slug: string };
  invitedBy!: { name: string } | null;
  role!: WireRole;
  // Masked: the preview is public.
  email!: string;
  expiresAt!: Date;
  status!: InviteStatus;

  constructor(partial: InvitePreviewDto) {
    Object.assign(this, partial);
  }
}

export class AcceptedInviteDto {
  organization!: { id: string; name: string; slug: string };
  role!: WireRole;

  constructor(partial: AcceptedInviteDto) {
    Object.assign(this, partial);
  }
}

export const displayName = (user: Pick<User, 'name' | 'email'>) =>
  user.name ?? user.email;

export function toInviteDto(
  invitation: Invitation & {
    invitedBy: Pick<User, 'id' | 'name' | 'email'> | null;
  },
): InviteDto {
  return new InviteDto({
    id: invitation.id,
    email: invitation.email,
    role: toWireRole(invitation.role),
    invitedBy: invitation.invitedBy
      ? {
          id: invitation.invitedBy.id,
          name: displayName(invitation.invitedBy),
        }
      : null,
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    delivery: {
      status:
        invitation.emailStatus.toLowerCase() as Lowercase<InvitationEmailStatus>,
      error: invitation.emailError,
    },
  });
}
