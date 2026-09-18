import { Role } from '../../../generated/prisma/enums';

export class CreateOrganizationResponseDto {
  id!: string;
  name!: string;
  slug!: string;
  role!: Role;
  integrations!: [];

  constructor(partial: { id: string; name: string; slug: string; role: Role }) {
    this.id = partial.id;
    this.name = partial.name;
    this.slug = partial.slug;
    this.role = partial.role;
    this.integrations = [];
  }
}
