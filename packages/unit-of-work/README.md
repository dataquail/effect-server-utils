# @effect-server-utils/unit-of-work

The unit-of-work boundary for [Effect](https://effect.website): a re-entrant atomicity port over your
own transaction primitive, and the after-commit delivery it gives
[`@effect-server-utils/cqrs`](https://www.npmjs.com/package/@effect-server-utils/cqrs)'s event bus.

```sh
pnpm add @effect-server-utils/unit-of-work @effect-server-utils/cqrs effect
```

Both `effect` and `@effect-server-utils/cqrs` are peer dependencies.

## Why it is its own package

The CQRS package has no opinion about transactions. Its event bus knows that some subscriptions want
to run _after_ whatever produced the event has finished, and it knows nothing about what "finished"
means — it hands those events to a `DeferralSink` if one is in context, and runs them at the end of
the dispatch if none is.

This package is that sink, and the boundary that gives it a commit to wait for. Install it when your
host has a datastore whose atomicity you want a use case to be able to declare; leave it out and the
bus still works, with `subscribeAfterCommit` degenerating to "after every immediate handler". Handlers
do not change between the two.

## What you get

- **`withUnitOfWork`** — the combinator a write-side use case applies once, at the end of its pipe. Every
  repository write inside commits together or is discarded together.
- **`UnitOfWork`** — the port behind it, so a use case can be unit-tested against a pass-through
  implementation without ever naming a datastore.
- **`TransactionDriver`** — the one thing you supply. Re-entrancy, deferral, drain ordering and failure
  isolation are this package's; the SQL is yours.
- **`PersistenceUnavailable`** — the transient-store failure a repository port names, so a module's
  `domain/` can describe it without importing infrastructure.
- **`@effect-server-utils/unit-of-work/testing`** — `PassThroughUnitOfWork` and in-memory drivers, for
  tests whose repositories are fakes.

## Supplying a driver

```ts
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  PersistenceUnavailable,
  TransactionDriver,
  TransactionFailed,
} from "@effect-server-utils/unit-of-work";

// An adapter is responsible for making its own scope handle ambient to the effect
// it wraps, so a repository inside picks it up. Nothing about that handle appears
// in the port — if it did, every consumer's read path would have to name it.
export const TransactionDriverLive: Layer.Layer<TransactionDriver, never, Database> = Layer.effect(
  TransactionDriver,
  Effect.gen(function* () {
    const db = yield* Database;
    return TransactionDriver.of({
      withTransaction: (effect) => db.transaction(effect),
      withSavepoint: (effect) => db.savepoint(effect),
      isActive: db.hasOpenTransaction,
    });
  }),
);
```

## Declaring the boundary

```ts
import { withUnitOfWork } from "@effect-server-utils/unit-of-work";

// Declared once and visibly, rather than buried in an inner block that dispatched
// event handlers would silently join.
const placeOrder = (input: Input) =>
  Effect.gen(function* () {
    const order = yield* orders.insert(input);
    yield* eventBus.dispatch([OrderPlaced.make({ orderId: order.id })]);
    return order.id;
  }).pipe(withUnitOfWork);
```

`run` is re-entrant: a bare call opens a scope, a call already inside one takes a savepoint instead of
reaching for a second connection. So a command dispatched from inside a caller's transaction joins it,
and a nested failure the caller catches discards only the nested scope.

`withUnitOfWork` demotes `TransactionFailed` to a defect — no use case can act on a rejected commit —
and leaves `PersistenceUnavailable` standing, which is the one a transport boundary turns into a 503.

## After-commit events

```ts
import { makeEventBus } from "@effect-server-utils/cqrs";
import { makeUnitOfWork } from "@effect-server-utils/unit-of-work";

// The boundary and the sink are installed together, because they are one decision:
// "after commit" has no meaning until something owns a commit.
const runtime = Layer.mergeAll(makeEventBus(), makeUnitOfWork()).pipe(
  Layer.provide(TransactionDriverLive),
);
```

With this wired, `bus.subscribeAfterCommit(...)` handlers run once the _outermost_ unit of work
commits, each in a fresh unit of work so its failure cannot undo the work it is reacting to, and the
drain is uninterruptible so a client hanging up does not discard reactions to work that is already
durable. A nested scope that rolls back discards what it deferred; the enclosing one still commits and
still drains its own.

Dispatching with no unit of work open is a tagged defect (`EventDispatchedOutsideUnitOfWork`) rather
than a quietly different delivery — once you have installed a boundary, a dispatch that forgot one is
a bug.

## Testing

```ts
import { PassThroughUnitOfWork } from "@effect-server-utils/unit-of-work/testing";
```

The real boundary over an in-memory driver: real re-entrancy, real after-commit ordering, real
discard-on-rollback, no datastore. Prefer it to a hand-rolled pass-through, which tends to get the
rollback case wrong.

## Documentation

Full documentation: <https://dataquail.github.io/effect-server-utils>

## License

MIT
