import { Prisma } from '../../generated/prisma/client';
import { SlugService } from './slug.service';

jest.mock('../../generated/prisma/client', () => ({ Prisma: {} }));

// `taken` slugs exist already (on some org other than `excludeOrgId`).
function setup(taken: string[] = []) {
  const findFirst = jest.fn(({ where }: { where: { slug: string } }) =>
    Promise.resolve(taken.includes(where.slug) ? { id: 'org_x' } : null),
  );
  const tx = {
    organization: { findFirst },
  } as unknown as Prisma.TransactionClient;
  return { service: new SlugService(), tx, findFirst };
}

describe('SlugService.generateUniqueOrgSlug', () => {
  it.each([
    ['Cititex Engineer', 'cititex-engineer'],
    ['  PT. Ácmé & Sons!  ', 'pt-acme-sons'],
    ['Über---Team__2026', 'uber-team-2026'],
    // Nothing usable left after slugifying.
    ['!!!', 'org'],
    ['東京', 'org'],
  ])('%p → %p', async (name, slug) => {
    const { service, tx } = setup();
    await expect(service.generateUniqueOrgSlug(tx, name)).resolves.toBe(slug);
  });

  it('caps the slug at 80 characters', async () => {
    const { service, tx } = setup();
    const slug = await service.generateUniqueOrgSlug(tx, 'a'.repeat(120));
    expect(slug).toHaveLength(80);
  });

  // Slugs are unique globally (critiq.id/<slug>); names are not.
  it('numbers a taken slug until a free one is found', async () => {
    const { service, tx } = setup(['acme', 'acme-1']);
    await expect(service.generateUniqueOrgSlug(tx, 'Acme')).resolves.toBe(
      'acme-2',
    );
  });

  // Renaming an org must not collide with its own current slug.
  it('ignores the org being renamed', async () => {
    const { service, tx, findFirst } = setup();
    await service.generateUniqueOrgSlug(tx, 'Acme', 'org_1');
    expect(findFirst).toHaveBeenCalledWith({
      where: { slug: 'acme', id: { not: 'org_1' } },
    });
  });

  it('checks every org when creating a new one', async () => {
    const { service, tx, findFirst } = setup();
    await service.generateUniqueOrgSlug(tx, 'Acme');
    expect(findFirst).toHaveBeenCalledWith({ where: { slug: 'acme' } });
  });
});
