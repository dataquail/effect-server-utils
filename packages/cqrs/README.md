# @effect-server-utils/cqrs

Typed CQRS for [Effect](https://effect.website): command and query buses with per-message success and
error types, an event bus whose subscriptions choose their consistency model, and process managers.

```sh
pnpm add @effect-server-utils/cqrs effect
```

`effect` is a peer dependency.

## What you get

- **`Command` / `Query`** — declare a message once, with its payload schema, its success type and its
  failure type. A handler that returns the wrong thing does not compile, and a caller reads both
  channels off the definition rather than off the bus. The two are separate facades over the same
  machinery so that a query group is rejected where a command group is expected — the CQRS distinction
  expressed in types.
- **`CommandBus` / `QueryBus`** — the application-wide dispatch surface. `bus.execute(Command, payload)`
  reads its signature off the definition you pass, so there is no side table a command's declaration
  could drift from.
- **`DispatchTable`** — folds each module's dispatcher into the one table a bus routes through. The
  three ways a table can be wrong (`DuplicateDispatchTag`, `UnroutableTags`, `MissingHandler`) travel
  as tagged defects, so a boot check can match the condition instead of parsing a message string.
- **`EventBus`** — one bus, three delivery contracts, chosen at _subscription_ rather than at dispatch.
  `subscribe` runs in the publisher's fiber and can roll it back; `subscribeAfterCommit` runs once the
  publisher's boundary has completed, in a boundary of its own, and never can; `stream` feeds a saga
  and is never awaited. A producer says only that something happened, so one event can serve consumers
  that need different things.
- **`DeferralSink`** — the optional seam that decides what `subscribeAfterCommit` waits for. This
  package does not know what a transaction is: install
  [`@effect-server-utils/unit-of-work`](https://www.npmjs.com/package/@effect-server-utils/unit-of-work)
  and after-commit means after commit; install nothing and those handlers run at the end of each
  dispatch. Handlers are written the same way either way.
- **`Saga`** — a process manager over deferred events, for when no single event decides.
- **`Middleware`** — behaviour applied once around every dispatch. `Middleware.span` is installed by
  default; `metrics()` and `deadline()` are opt-in. A middleware may not change a message's success or
  error channels, which is what lets the bus have a seam without weakening a caller's types.
- **`UnhandledFailures`** — where a failure goes when no caller is left to receive it.

## Declaring and dispatching a command

```ts
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command, CommandBus } from "@effect-server-utils/cqrs";

class OrderNotFound extends Schema.TaggedErrorClass<OrderNotFound>()("OrderNotFound", {
  orderId: Schema.String,
}) {}

const PlaceOrder = Command.make("PlaceOrder", {
  payload: { orderId: Schema.String },
  success: Schema.String,
  failure: OrderNotFound,
});

// A module groups the tags it owns and implements them in one place. Whatever
// services the handlers need become the Layer's requirements.
const Orders = Command.group(PlaceOrder);

export const OrdersHandlers = Command.handlersOf(Orders, {
  PlaceOrder: (payload) => Effect.succeed(`placed:${payload.orderId}`),
});

// At a call site, the channels come from the definition — not from the bus.
const program = Effect.gen(function* () {
  const bus = yield* CommandBus;
  const receipt = yield* bus.execute(PlaceOrder, { orderId: "ord_1" });
  return receipt;
}).pipe(Effect.catchTag("OrderNotFound", (e) => Effect.succeed(`missing:${e.orderId}`)));
```

At the composition root, each module's dispatch surface is merged into the table the bus routes
through:

```ts
import { makeCommandBus, mergeDispatchTables } from "@effect-server-utils/cqrs";

const table = mergeDispatchTables(ordersDispatcher, billingDispatcher);
const bus = makeCommandBus(table, { declaredIn: [Orders, Billing] });
```

## Events

```ts
import { Event } from "@effect-server-utils/cqrs";

const OrderPlaced = Event.make("OrderPlaced", { orderId: Schema.String });

const subscriptions = Effect.gen(function* () {
  const bus = yield* EventBus;

  // Part of the same logical operation: its failure rolls the publisher back.
  yield* bus.subscribe(OrderPlaced, (event) => inventory.reserve(event.orderId));

  // A reaction to work that is already durable: isolated, retried on its own.
  yield* bus.subscribeAfterCommit(OrderPlaced, (event) => email.sendReceipt(event.orderId));
});
```

"Already durable" needs something to be durable _in_. With no `DeferralSink` in context the bus runs
after-commit handlers at the end of the dispatch — still after every immediate one, still isolated —
which is enough for a host with no datastore to coordinate. Add
`@effect-server-utils/unit-of-work` and the same handlers start running after a real commit, each in
a transaction of its own, with nothing above rewritten:

```ts
import { makeUnitOfWork, withUnitOfWork } from "@effect-server-utils/unit-of-work";

// Installs the sink alongside the boundary — they are one decision.
const runtime = Layer.mergeAll(makeEventBus(), makeUnitOfWork()).pipe(
  Layer.provide(YourTransactionDriver),
);

// The boundary a use case declares once, at the end of its pipe.
const placeOrder = (input: Input) => doTheWork(input).pipe(withUnitOfWork);
```

## Testing helpers

Serializability checks live behind their own entry point, because they derive sample values with a
property-testing runtime that has no business in a consumer's production process:

```ts
import { checkEventsSerializable, checkSerializable } from "@effect-server-utils/cqrs/testing";

const check = Effect.gen(function* () {
  const problems = yield* checkSerializable(Orders); // empty means every contract is portable
});
```

## Documentation

Full documentation: <https://dataquail.github.io/effect-server-utils>

## License

MIT
