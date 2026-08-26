import { deepStrictEqual } from "node:assert";

import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { DeferralSink } from "./deferral.js";
import * as Event from "./event.js";
import { EventBus, makeEventBus } from "./event-bus.js";

const TestEvent = Event.make("TestEvent", { value: Schema.String });
const OtherEvent = Event.make("OtherEvent", { value: Schema.String });

/**
 * A sink that only records, standing in for one that owns a boundary. Deferred
 * events go in and nothing comes out until a test calls `drain` itself, which is
 * exactly the shape of the contract: the bus hands them over and forgets them.
 */
const recordingSink = Effect.gen(function* () {
  const taken = yield* Ref.make<ReadonlyArray<Event.Base>>([]);
  return {
    taken: Ref.get(taken),
    layer: Layer.succeed(
      DeferralSink,
      DeferralSink.of({
        defer: (events) => Ref.update(taken, (prev) => [...prev, ...events]),
      }),
    ),
  };
});

describe("EventBus.subscribe (immediate)", () => {
  it.effect("runs a subscriber in the publisher's fiber", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const ran = yield* Ref.make(false);
      yield* bus.subscribe(TestEvent, () => Ref.set(ran, true));

      yield* bus.dispatch([TestEvent.make({ value: "a" })]);

      deepStrictEqual(yield* Ref.get(ran), true);
    }).pipe(Effect.provide(makeEventBus())),
  );

  it.effect("runs every subscriber for a tag, in registration order", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* bus.subscribe(TestEvent, () => Ref.update(order, (prev) => [...prev, "first"]));
      yield* bus.subscribe(TestEvent, () => Ref.update(order, (prev) => [...prev, "second"]));

      yield* bus.dispatch([TestEvent.make({ value: "a" })]);

      deepStrictEqual(yield* Ref.get(order), ["first", "second"]);
    }).pipe(Effect.provide(makeEventBus())),
  );

  // The failure direction that distinguishes this surface from the after-commit
  // one: a subscriber's failure must reach the publisher so its boundary rolls
  // back.
  it.effect("propagates a subscriber's failure to the publisher", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      yield* bus.subscribe(TestEvent, () => Effect.die("subscriber exploded"));

      const exit = yield* Effect.exit(bus.dispatch([TestEvent.make({ value: "a" })]));

      deepStrictEqual(Exit.isFailure(exit), true);
    }).pipe(Effect.provide(makeEventBus())),
  );
});

describe("EventBus.subscribeAfterCommit, with a sink", () => {
  // The distinguishing behaviour: dispatch does not run these. Whoever owns the
  // boundary drains them once it has completed, which is what keeps a reaction
  // from being able to undo its trigger.
  it.effect("dispatch hands the events to the sink and runs no handler", () =>
    Effect.gen(function* () {
      const sink = yield* recordingSink;
      const ran = yield* Ref.make(false);

      const taken = yield* Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.subscribeAfterCommit(TestEvent, () => Ref.set(ran, true));
        yield* bus.dispatch([TestEvent.make({ value: "a" })]);
        return yield* sink.taken;
      }).pipe(Effect.provide(Layer.merge(makeEventBus(), sink.layer)));

      deepStrictEqual(
        taken.map((event) => event._tag),
        ["TestEvent"],
      );
      deepStrictEqual(yield* Ref.get(ran), false);
    }),
  );

  // Order matters for the one case where it is observable: a sink with nothing
  // open to defer onto must be able to say so before the dispatch has run half
  // its handlers.
  it.effect("hands the events over before any immediate handler runs", () =>
    Effect.gen(function* () {
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      const sink = Layer.succeed(
        DeferralSink,
        DeferralSink.of({
          defer: () => Ref.update(order, (prev) => [...prev, "deferred"]),
        }),
      );

      yield* Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.subscribe(TestEvent, () => Ref.update(order, (prev) => [...prev, "immediate"]));
        yield* bus.dispatch([TestEvent.make({ value: "a" })]);
      }).pipe(Effect.provide(Layer.merge(makeEventBus(), sink)));

      deepStrictEqual(yield* Ref.get(order), ["deferred", "immediate"]);
    }),
  );

  // The capability the merge exists for. Under two buses a producer picked one
  // consistency model for every consumer; here one dispatch serves a reaction that
  // must be atomic with it and one that must not be.
  it.effect("one dispatch serves an immediate and an after-commit subscriber at once", () =>
    Effect.gen(function* () {
      const sink = yield* recordingSink;
      const ran = yield* Ref.make<ReadonlyArray<string>>([]);

      const taken = yield* Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.subscribe(TestEvent, () => Ref.update(ran, (prev) => [...prev, "immediate"]));
        yield* bus.subscribeAfterCommit(TestEvent, () =>
          Ref.update(ran, (prev) => [...prev, "afterCommit"]),
        );
        yield* bus.dispatch([TestEvent.make({ value: "a" })]);
        return yield* sink.taken;
      }).pipe(Effect.provide(Layer.merge(makeEventBus(), sink.layer)));

      // Only the immediate one has run; the other is the sink's now.
      deepStrictEqual(yield* Ref.get(ran), ["immediate"]);
      deepStrictEqual(taken.length, 1);
    }),
  );
});

// The reason the sink is optional. A host with no transactions still gets both
// subscription surfaces, and a handler written against either one is correct
// whether or not a unit of work is ever installed underneath it.
describe("EventBus.subscribeAfterCommit, with no sink", () => {
  it.effect("runs after-commit handlers at the end of the dispatch, after the immediate ones", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const ran = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* bus.subscribeAfterCommit(TestEvent, () =>
        Ref.update(ran, (prev) => [...prev, "afterCommit"]),
      );
      yield* bus.subscribe(TestEvent, () => Ref.update(ran, (prev) => [...prev, "immediate"]));

      yield* bus.dispatch([TestEvent.make({ value: "a" })]);

      deepStrictEqual(yield* Ref.get(ran), ["immediate", "afterCommit"]);
    }).pipe(Effect.provide(makeEventBus())),
  );

  // The isolation half of the contract survives the degenerate wiring too, which
  // is what makes the two modes interchangeable from a handler's point of view.
  it.effect("isolates an after-commit failure from the publisher", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const handled = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* bus.subscribeAfterCommit(TestEvent, () => Effect.die("reaction exploded"));
      yield* bus.subscribeAfterCommit(TestEvent, (event) =>
        Ref.update(handled, (prev) => [...prev, event.value]),
      );

      const exit = yield* Effect.exit(bus.dispatch([TestEvent.make({ value: "a" })]));

      deepStrictEqual(Exit.isSuccess(exit), true);
      deepStrictEqual(yield* Ref.get(handled), ["a"]);
    }).pipe(Effect.provide(makeEventBus())),
  );

  it.effect("dispatching outside any boundary is not an error", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      yield* bus.subscribe(TestEvent, () => Effect.void);

      const exit = yield* Effect.exit(bus.dispatch([TestEvent.make({ value: "a" })]));

      deepStrictEqual(Exit.isSuccess(exit), true);
    }).pipe(Effect.provide(makeEventBus())),
  );
});

describe("EventBus.drain", () => {
  // The seam a sink reaches through. The bus keeps the parts that are its own —
  // which handlers, in what order, spans, isolation — and takes only "run it in
  // here" from the caller.
  it.effect("runs every after-commit handler inside the boundary it is given", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const wrapped = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* bus.subscribeAfterCommit(TestEvent, () => Effect.void);
      yield* bus.subscribeAfterCommit(TestEvent, () => Effect.void);

      yield* bus.drain([TestEvent.make({ value: "a" })], (reaction) =>
        Effect.andThen(
          Ref.update(wrapped, (prev) => [...prev, "boundary"]),
          reaction,
        ),
      );

      deepStrictEqual(yield* Ref.get(wrapped), ["boundary", "boundary"]);
    }).pipe(Effect.provide(makeEventBus())),
  );

  // A boundary can fail in ways the handler never declared — opening a
  // transaction, releasing a savepoint. That cannot be allowed to escape into
  // the drain, which is running after its producer is already durable.
  it.effect("isolates a boundary that fails around a handler that did not", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const ran = yield* Ref.make(false);
      yield* bus.subscribeAfterCommit(TestEvent, () => Ref.set(ran, true));

      const exit = yield* Effect.exit(
        bus.drain([TestEvent.make({ value: "a" })], () => Effect.fail("boundary rejected")),
      );

      deepStrictEqual(Exit.isSuccess(exit), true);
      deepStrictEqual(yield* Ref.get(ran), false);
    }).pipe(Effect.provide(makeEventBus())),
  );
});

describe("EventBus.stream", () => {
  // The saga seam. `subscribeAfterCommit` handlers are awaited and isolated; a
  // stream is published to and not awaited, because a process manager may run for
  // days and must never hold up a drain.
  it.effect("emits broadcast events, filtered to the requested tags", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const collected = yield* Ref.make<ReadonlyArray<string>>([]);

      const events = yield* bus.stream([TestEvent.tag]);
      const consuming = yield* Effect.forkScoped(
        Stream.runForEach(events, (event) =>
          Ref.update(collected, (prev) => [...prev, event._tag]),
        ),
      );

      yield* bus.broadcast([
        TestEvent.make({ value: "a" }),
        OtherEvent.make({ value: "b" }),
        TestEvent.make({ value: "c" }),
      ]);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(consuming);

      deepStrictEqual(yield* Ref.get(collected), ["TestEvent", "TestEvent"]);
    }).pipe(Effect.scoped, Effect.provide(makeEventBus())),
  );

  // With no sink the broadcast is part of the dispatch, so a saga wired into a
  // host that has no unit of work still sees its events.
  it.effect("a dispatch with no sink reaches a stream consumer", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const collected = yield* Ref.make<ReadonlyArray<string>>([]);

      const events = yield* bus.stream([TestEvent.tag]);
      const consuming = yield* Effect.forkScoped(
        Stream.runForEach(events, (event) =>
          Ref.update(collected, (prev) => [...prev, event._tag]),
        ),
      );

      yield* bus.dispatch([TestEvent.make({ value: "a" })]);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(consuming);

      deepStrictEqual(yield* Ref.get(collected), ["TestEvent"]);
    }).pipe(Effect.scoped, Effect.provide(makeEventBus())),
  );

  // A stream with no consumer must not accumulate, or a bus in a process with no
  // sagas would grow without bound.
  it.effect("broadcast with no consumer completes and retains nothing", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;

      yield* bus.broadcast([TestEvent.make({ value: "a" })]);

      const collected = yield* Ref.make<ReadonlyArray<string>>([]);
      const events = yield* bus.stream([TestEvent.tag]);
      const consuming = yield* Effect.forkScoped(
        Stream.runForEach(events, (event) =>
          Ref.update(collected, (prev) => [...prev, event._tag]),
        ),
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(consuming);

      deepStrictEqual(yield* Ref.get(collected), []);
    }).pipe(Effect.scoped, Effect.provide(makeEventBus())),
  );
});
