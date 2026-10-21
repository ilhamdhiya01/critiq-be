import { readdirSync } from 'fs';
import { join, relative } from 'path';
import { RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { Role } from '../../generated/prisma/enums';
import { ORG_ROLES_KEY } from '../decorators/org-roles.decorator';
import { OrgRolesGuard } from './org-roles.guard';

// ESM-only or network-bound packages pulled in by the controllers' imports.
// Only the routing metadata is under test here, never a request.
jest.mock('@nestjs/passport', () => ({
  AuthGuard: () => class {},
  PassportStrategy: () => class {},
}));
jest.mock('@nestjs/config', () => ({ ConfigService: class {} }));
jest.mock('@nestjs/jwt', () => ({ JwtService: class {} }));
jest.mock('@nestjs/axios', () => ({ HttpService: class {} }));
jest.mock('@nestjs/bullmq', () => ({
  InjectQueue: () => () => undefined,
  Processor: () => () => undefined,
  OnWorkerEvent: () => () => undefined,
  WorkerHost: class {},
}));
jest.mock('bullmq', () => ({
  Job: class {},
  Queue: class {},
  UnrecoverableError: class extends Error {},
}));
jest.mock('openai', () => class {});
jest.mock('@anthropic-ai/sdk', () => class {});
jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('@octokit/request', () => ({ request: jest.fn() }));
jest.mock('@octokit/request-error', () => ({ RequestError: class {} }));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../../generated/prisma/client', () => ({
  Prisma: {},
  PrismaClient: class {},
}));

// Mutating routes that are deliberately not org-scoped. Each one must keep
// existing — a stale entry fails the suite instead of silently widening the
// allow-list.
const PUBLIC_MUTATIONS: Record<string, string> = {
  'POST auth/logout': 'clears the caller’s own cookie, no data touched',
  'POST invites/:token/accept':
    'joins an org the caller is not a member of yet (session required)',
  'POST orgs': 'creates a new org; the caller becomes its Admin',
  'POST webhooks/gitlab': 'provider delivery, verified by signature',
  'POST webhooks/github': 'provider delivery, verified by signature',
};

const MUTATIONS = new Set([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

interface Route {
  key: string;
  method: RequestMethod;
  guards: unknown[];
  roles: Role[] | undefined;
}

type Constructor = new (...args: never[]) => unknown;

function controllerFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'fixtures' ? [] : controllerFiles(path);
    }
    return entry.name.endsWith('.controller.ts') ? [path] : [];
  });
}

// Every controller here declares single string paths, never arrays.
const pathOf = (target: object) =>
  (Reflect.getMetadata(PATH_METADATA, target) as string | undefined) ?? '';

const guardsOf = (target: object) =>
  (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];

const joinPath = (...parts: string[]) =>
  parts
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

function routesOf(controller: Constructor): Route[] {
  const prefix = pathOf(controller);
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto).flatMap((name) => {
    const handler = proto[name];
    if (typeof handler !== 'function') {
      return [];
    }
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as
      RequestMethod | undefined;
    if (method === undefined) {
      return [];
    }
    const guards = [...guardsOf(controller), ...guardsOf(handler)];
    const roles = (Reflect.getMetadata(ORG_ROLES_KEY, handler) ??
      Reflect.getMetadata(ORG_ROLES_KEY, controller)) as Role[] | undefined;
    return [
      {
        key: `${RequestMethod[method]} ${joinPath(prefix, pathOf(handler))}`,
        method,
        guards,
        roles,
      },
    ];
  });
}

const srcDir = join(__dirname, '..', '..');
const routes = controllerFiles(srcDir).flatMap((file) => {
  const exports = jest.requireActual<Record<string, unknown>>(file);
  const controllers = Object.values(exports).filter(
    (value): value is Constructor =>
      typeof value === 'function' &&
      Reflect.getMetadata(PATH_METADATA, value) !== undefined,
  );
  if (controllers.length === 0) {
    throw new Error(`${relative(srcDir, file)} exports no controller`);
  }
  return controllers.flatMap(routesOf);
});

const orgScoped = routes.filter((route) => route.key.includes(':orgId'));
const mutations = routes.filter(
  (route) => MUTATIONS.has(route.method) && !(route.key in PUBLIC_MUTATIONS),
);

describe('route authorization (every controller)', () => {
  it('discovers the controllers', () => {
    expect(orgScoped.length).toBeGreaterThan(40);
    expect(mutations.length).toBeGreaterThan(20);
  });

  // CLAUDE.md "Multi-tenancy": the role is re-read from the DB for the
  // :orgId in the URL — a route without the guard trusts the token.
  it.each(orgScoped.map((route) => [route.key, route]))(
    '%s re-verifies the org membership',
    (_, route) => {
      expect(route.guards).toContain(OrgRolesGuard);
    },
  );

  // CLAUDE.md "Role Viewer": read-only, enforced at the guard.
  it.each(mutations.map((route) => [route.key, route]))(
    '%s is closed to Viewers',
    (_, route) => {
      expect(route.guards).toContain(OrgRolesGuard);
      expect(route.roles?.length).toBeGreaterThan(0);
      expect(route.roles).not.toContain(Role.VIEWER);
    },
  );

  it.each(Object.keys(PUBLIC_MUTATIONS))(
    'public mutation %s still exists',
    (key) => {
      expect(routes.map((route) => route.key)).toContain(key);
    },
  );
});
