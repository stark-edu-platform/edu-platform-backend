# Backend tests

Unit-test harness for `edu-platform-backend`, established by
[PRP-73](./PRP-73-backend-test-harness.md). Runner: **Vitest** (ESM-native, fits
`"type": "module"`).

## Running

```bash
pnpm test            # vitest run (one-shot)
pnpm test:watch      # vitest (watch mode)
pnpm test:coverage   # vitest run --coverage (writes ./coverage, git-ignored)
```

## Conventions

- **Co-locate** `*.test.ts` beside the unit under test
  (e.g. `src/utils/api-response.test.ts`), mirroring the module-local style.
- Tests import their target with the same explicit `.js` extension the sources
  use (`./auth.utils.js`). `vitest.config.ts` ships a small `ts-js-ext` resolver
  that maps `./x.js` -> `x.ts` exactly as `tsx` does at runtime.
- **No database in unit tests.** Services take `fastify` as their first arg and
  reach `fastify.prisma` / `fastify.config` / `fastify.httpErrors`; tests pass a
  stub instead (below). Integration / route (`app.inject()`) tests against a real
  Postgres are a separate, future PRP.

## Testing a pure helper

```ts
import { describe, expect, it } from 'vitest';
import { isValidPassword } from './auth.utils.js';

describe('isValidPassword', () => {
  it('rejects passwords shorter than 8 characters', () => {
    expect(isValidPassword('short')).toBe(false);
  });
});
```

## Testing a service (no DB)

`makeFastifyStub()` (in `src/testing/fastify-stub.ts`) returns a `FastifyInstance`
whose `prisma` is an auto-mock: **any** model method you touch
(`prisma.user.findUnique`, `prisma.school.updateMany`, `prisma.$transaction`, …)
is a fresh `vi.fn()`. `httpErrors.*` return `Error`s carrying `statusCode`.

Use `asMock(...)` to view a stubbed function as a Vitest `Mock` for its
`.mock*` / call-assertion helpers.

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { asMock, makeFastifyStub } from '../../testing/fastify-stub.js';
import { getCurrentUser } from './auth.service.js';

describe('getCurrentUser', () => {
  let fastify: ReturnType<typeof makeFastifyStub>;

  beforeEach(() => {
    fastify = makeFastifyStub();
  });

  it('throws a 404 when the user does not exist', async () => {
    asMock(fastify.prisma.user.findUnique).mockResolvedValue(null);

    await expect(getCurrentUser(fastify, 'missing')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
```

Override config when a service reads it: `makeFastifyStub({ config: { ACCESS_TOKEN_TTL_MINUTES: 5 } })`.
Create a fresh stub per test (e.g. in `beforeEach`) so mock state never leaks.

## TypeScript / build notes

- `*.test.ts` and `src/testing/**` are type-checked and linted (they live under
  `src/`), but excluded from the production build via `tsconfig.build.json`
  (`pnpm build` → `tsc -p tsconfig.build.json`), so they never ship to `dist/`.
- `tsconfig.json` lists `vitest/globals` in `compilerOptions.types`, so the
  global test APIs are typed even when not explicitly imported.

## Follow-ons (not in this harness)

Integration/route tests against a disposable Postgres, CI wiring, and coverage
thresholds — see PRP-73 §8.
