import { deepStrictEqual } from "node:assert";

import { describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Event from "./event.js";
import { EventBus, makeEventBus } from "./event-bus.js";
import * as Saga from "./saga.js";

const OrderPlaced = Event.make("OrderPlaced", { orderId: Schema.String });
const PaymentCaptured = Event.make("PaymentCaptured", { orderId: Schema.String });

/** Where a saga under test records what it decided, in place of dispatching. */
class Shipments extends Context.Service<
  Shipments,
  { readonly ship: (orderId: string) => Effect.Effect<void> }
>()("test/Shipments") {}

/**
 * A bus with no deferral sink, so a dispatch broadcasts as part of itself. What
 * a saga reads is the broadcast; whether it arrives at dispatch time or after a
 * commit is the sink's business, not the runner's.
 */
const cqrsRuntime = makeEventBus();

/**
 * Something the publisher can be seen to have in its context, standing in for
 * whatever a real one carries — an open transaction, a request scope. A saga
 * must never find it.
 */
class PublisherScope extends Context.Service<PublisherScope, { readonly open: true }>()(
  "test/PublisherScope",
) {}

/** Dispatches the given events from inside a publisher's scope, then lets sagas run. */
const publish = (events: ReadonlyArray<{ readonly _tag: string }>) =>
  Effect.gen(function* () {
    const bus = yield* EventBus;
    yield* Effect.provideService(bus.dispatch(events), PublisherScope, { open: true });
    yield* Effect.yieldNow;
  });

describe("Saga", () => {
  // Correlation across two events is what a saga buys over a stateless event
  // adapter: neither event alone is enough to decide.
  it.effect("correlates two events before acting", () =>
    Effect.gen(function* () {
      const shipped = yield* Ref.make<ReadonlyArray<string>>([]);
      const runtime = cqrsRuntime;

      const fulfillment = Saga.make({
        name: "OrderFulfillment",
        events: [OrderPlaced, PaymentCaptured],
        run: (events) =>
          Effect.gen(function* () {
            const shipments = yield* Shipments;
            const seen = new Map<string, Set<string>>();
            yield* Stream.runForEach(events, (event) => {
              const forOrder = seen.get(event.orderId) ?? new Set<string>();
              forOrder.add(event._tag);
              seen.set(event.orderId, forOrder);
              return forOrder.has("OrderPlaced") && forOrder.has("PaymentCaptured")
                ? shipments.ship(event.orderId)
                : Effect.void;
            });
          }),
      });

      yield* Effect.gen(function* () {
        yield* publish([OrderPlaced.make({ orderId: "order-1" })]);
        deepStrictEqual(yield* Ref.get(shipped), []);

        yield* publish([PaymentCaptured.make({ orderId: "order-1" })]);
        deepStrictEqual(yield* Ref.get(shipped), ["order-1"]);
      }).pipe(
        Effect.provide(
          Saga.runner(fulfillment).pipe(
            Layer.provideMerge(runtime),
            Layer.provide(
              Layer.succeed(Shipments, {
                ship: (orderId) => Ref.update(shipped, (prev) => [...prev, orderId]),
              }),
            ),
          ),
        ),
      );
    }),
  );

  // The load-bearing safety property. The runner forks from the layer's scope, so
  // a saga's fiber cannot inherit a publisher's context — if it did, it would
  // issue queries on a connection about to commit and be released.
  it.effect("does not inherit the publisher's scope", () =>
    Effect.gen(function* () {
      const sawScope = yield* Ref.make<ReadonlyArray<boolean>>([]);
      const runtime = cqrsRuntime;

      const observer = Saga.make({
        name: "ScopeObserver",
        events: [OrderPlaced],
        run: (events) =>
          Stream.runForEach(events, () =>
            Effect.flatMap(Effect.serviceOption(PublisherScope), (scope) =>
              Ref.update(sawScope, (prev) => [...prev, Option.isSome(scope)]),
            ),
          ),
      });

      yield* publish([OrderPlaced.make({ orderId: "order-1" })]).pipe(
        Effect.provide(Saga.runner(observer).pipe(Layer.provideMerge(runtime))),
      );

      deepStrictEqual(yield* Ref.get(sawScope), [false]);
    }),
  );

  it.effect("a slow saga does not hold up the dispatch", () =>
    Effect.gen(function* () {
      const started = yield* Ref.make(false);
      const runtime = cqrsRuntime;

      const slow = Saga.make({
        name: "SlowSaga",
        events: [OrderPlaced],
        run: (events) =>
          Stream.runForEach(events, () => Effect.andThen(Ref.set(started, true), Effect.never)),
      });

      // Completing at all is the assertion: an awaited saga would hang here.
      yield* publish([OrderPlaced.make({ orderId: "order-1" })]).pipe(
        Effect.provide(Saga.runner(slow).pipe(Layer.provideMerge(runtime))),
      );

      deepStrictEqual(yield* Ref.get(started), true);
    }),
  );

  // One saga's bug must not silently stop the others, which is the failure mode a
  // shared consumer fiber would have.
  it.effect("a saga that dies leaves the others running", () =>
    Effect.gen(function* () {
      const survivor = yield* Ref.make<ReadonlyArray<string>>([]);
      const runtime = cqrsRuntime;

      const doomed = Saga.make({
        name: "Doomed",
        events: [OrderPlaced],
        run: (events) => Stream.runForEach(events, () => Effect.die("saga exploded")),
      });
      const healthy = Saga.make({
        name: "Healthy",
        events: [OrderPlaced],
        run: (events) =>
          Stream.runForEach(events, (event) =>
            Ref.update(survivor, (prev) => [...prev, event.orderId]),
          ),
      });

      yield* Effect.gen(function* () {
        yield* publish([OrderPlaced.make({ orderId: "order-1" })]);
        yield* publish([OrderPlaced.make({ orderId: "order-2" })]);
      }).pipe(Effect.provide(Saga.runner(doomed, healthy).pipe(Layer.provideMerge(runtime))));

      deepStrictEqual(yield* Ref.get(survivor), ["order-1", "order-2"]);
    }),
  );

  it.effect("each saga receives only the events it declared", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<ReadonlyArray<string>>([]);
      const runtime = cqrsRuntime;

      const onPlaced = Saga.make({
        name: "OnPlaced",
        events: [OrderPlaced],
        run: (events) =>
          Stream.runForEach(events, (event) =>
            Ref.update(seen, (prev) => [...prev, `placed:${event._tag}`]),
          ),
      });
      const onCaptured = Saga.make({
        name: "OnCaptured",
        events: [PaymentCaptured],
        run: (events) =>
          Stream.runForEach(events, (event) =>
            Ref.update(seen, (prev) => [...prev, `captured:${event._tag}`]),
          ),
      });

      yield* publish([
        OrderPlaced.make({ orderId: "order-1" }),
        PaymentCaptured.make({ orderId: "order-1" }),
      ]).pipe(Effect.provide(Saga.runner(onPlaced, onCaptured).pipe(Layer.provideMerge(runtime))));

      deepStrictEqual([...(yield* Ref.get(seen))].sort(), [
        "captured:PaymentCaptured",
        "placed:OrderPlaced",
      ]);
    }),
  );

  it.effect("derives the tags it subscribes to from its events", () => {
    const saga = Saga.make({
      name: "OrderFulfillment",
      events: [OrderPlaced, PaymentCaptured],
      run: () => Effect.void,
    });

    deepStrictEqual(saga.name, "OrderFulfillment");
    deepStrictEqual(saga.tags, ["OrderPlaced", "PaymentCaptured"]);
    return Effect.void;
  });
});
