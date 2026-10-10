import { deepStrictEqual, ok } from "node:assert";

import { describe, it } from "@effect/vitest";
import {
  Event,
  type Event as EventNs,
  EventBus,
  makeEventBus,
  type UnhandledFailure,
  UnhandledFailures,
} from "@effect-server-utils/cqrs";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { AfterCommitTransport } from "./durable.js";
import { InMemoryDeliveryLedger, makeRecordingDriver, makeRecordingTransport } from "./testing.js";
import { TransactionDriver } from "./transaction-driver.js";
import { deliverOnce, makeDurableUnitOfWork, UnitOfWork, withUnitOfWork } from "./unit-of-work.js";

const Issued = Event.make("Issued", { id: Schema.String });
const Logged = Event.make("Logged", { id: Schema.String });

/**
 * A durable boundary over the recording driver and a recording transport, plus
 * a log of when each transport call ran relative to the transaction.
 */
const durableHarness = Effect.gen(function* () {
  const { driver } = yield* makeRecordingDriver;
  const recording = yield* makeRecordingTransport;
  const timeline = yield* Ref.make<ReadonlyArray<string>>([]);
  const note = (entry: string) => Ref.update(timeline, (prev) => [...prev, entry]);
  const phase = Effect.map(driver.isActive, (open) => (open ? "in-transaction" : "after-commit"));

  const transport = AfterCommitTransport.of({
    enqueue: (envelopes) =>
      Effect.flatMap(phase, (when) => note(`enqueue:${envelopes.length}:${when}`)).pipe(
        Effect.andThen(recording.transport.enqueue(envelopes)),
      ),
    flush: (envelopes) =>
      Effect.flatMap(phase, (when) => note(`flush:${envelopes.length}:${when}`)).pipe(
        Effect.andThen(recording.transport.flush(envelopes)),
      ),
  });

  const layer = Layer.mergeAll(
    makeDurableUnitOfWork().pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(TransactionDriver, driver),
          Layer.succeed(AfterCommitTransport, transport),
        ),
      ),
    ),
    makeEventBus(),
    InMemoryDeliveryLedger,
  );

  return { layer, recording, note, isActive: driver.isActive, timeline: Ref.get(timeline) };
});

/** The one envelope a single-subscription dispatch seals. */
const only = <A, E, R>(envelopes: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  Effect.flatMap(envelopes, ([envelope, ...rest]) =>
    envelope !== undefined && rest.length === 0
      ? Effect.succeed(envelope)
      : Effect.die(
          `expected exactly one envelope, got ${rest.length + (envelope === undefined ? 0 : 1)}`,
        ),
  );

describe("makeDurableUnitOfWork", () => {
  it.effect("enqueues inside the transaction and flushes after it commits", () =>
    Effect.gen(function* () {
      const harness = yield* durableHarness;
      yield* Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.subscribe(Issued, () => harness.note("immediate"));
        yield* bus.subscribeAfterCommit(Issued, () => harness.note("in-process"), {
          name: "notify",
        });
        yield* withUnitOfWork(bus.dispatch([Issued.make({ id: "a" })]));
      }).pipe(Effect.provide(harness.layer));

      deepStrictEqual(yield* harness.timeline, [
        "enqueue:1:in-transaction",
        "immediate",
        "flush:1:after-commit",
      ]);
      deepStrictEqual(yield* harness.recording.flushed, yield* harness.recording.enqueued);
    }),
  );

  it.effect("never flushes what a failed unit of work enqueued", () =>
    Effect.gen(function* () {
      const harness = yield* durableHarness;
      yield* Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.subscribeAfterCommit(Issued, () => Effect.void, { name: "notify" });
        yield* Effect.exit(
          withUnitOfWork(
            Effect.andThen(bus.dispatch([Issued.make({ id: "a" })]), Effect.fail("rejected")),
          ),
        );
      }).pipe(Effect.provide(harness.layer));

      deepStrictEqual((yield* harness.recording.enqueued).length, 1);
      deepStrictEqual(yield* harness.recording.flushed, []);
    }),
  );

  it.effect("drops a rolled-back savepoint's envelopes and flushes the rest", () =>
    Effect.gen(function* () {
      const harness = yield* durableHarness;
      yield* Effect.gen(function* () {
        const bus = yield* EventBus;
        const uow = yield* UnitOfWork;
        yield* bus.subscribeAfterCommit(Issued, () => Effect.void, { name: "notify" });
        yield* withUnitOfWork(
          Effect.gen(function* () {
            yield* bus.dispatch([Issued.make({ id: "kept" })]);
            yield* Effect.exit(
              uow.run(
                Effect.andThen(bus.dispatch([Issued.make({ id: "undone" })]), Effect.fail("no")),
              ),
            );
          }),
        );
      }).pipe(Effect.provide(harness.layer));

      deepStrictEqual(
        (yield* harness.recording.flushed).map((envelope) => envelope.payload),
        [{ _tag: "Issued", id: "kept" }],
      );
    }),
  );

  it.effect("writes nothing for a dispatch no after-commit subscription answers", () =>
    Effect.gen(function* () {
      const harness = yield* durableHarness;
      yield* Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.subscribe(Logged, () => harness.note("immediate"));
        yield* withUnitOfWork(bus.dispatch([Logged.make({ id: "a" })]));
      }).pipe(Effect.provide(harness.layer));

      deepStrictEqual(yield* harness.timeline, ["immediate"]);
    }),
  );

  it.effect("still broadcasts to stream consumers after commit", () =>
    Effect.gen(function* () {
      const harness = yield* durableHarness;
      const received = yield* Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.subscribeAfterCommit(Issued, () => Effect.void, { name: "notify" });
        const consumer = yield* Effect.forkScoped(
          Stream.runCollect(Stream.take(yield* bus.stream(["Issued", "Logged"]), 2)),
        );
        yield* withUnitOfWork(bus.dispatch([Issued.make({ id: "a" }), Logged.make({ id: "b" })]));
        return yield* Fiber.join(consumer);
      }).pipe(Effect.scoped, Effect.provide(harness.layer));

      deepStrictEqual(
        received.map((event: EventNs.Base) => event._tag),
        ["Issued", "Logged"],
      );
    }),
  );

  it.effect("isolates and reports a failed flush; the publisher still succeeds", () =>
    Effect.gen(function* () {
      const { driver } = yield* makeRecordingDriver;
      const reported = yield* Ref.make<ReadonlyArray<UnhandledFailure>>([]);
      const result = yield* Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.subscribeAfterCommit(Issued, () => Effect.void, { name: "notify" });
        return yield* withUnitOfWork(Effect.as(bus.dispatch([Issued.make({ id: "a" })]), "ok"));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            makeDurableUnitOfWork().pipe(
              Layer.provide(
                Layer.merge(
                  Layer.succeed(TransactionDriver, driver),
                  Layer.succeed(
                    AfterCommitTransport,
                    AfterCommitTransport.of({
                      enqueue: () => Effect.void,
                      flush: () => Effect.die("queue down"),
                    }),
                  ),
                ),
              ),
            ),
            makeEventBus(),
            Layer.succeed(
              UnhandledFailures,
              UnhandledFailures.of({
                report: (failure) => Ref.update(reported, (prev) => [...prev, failure]),
                stream: Effect.die("unused"),
              }),
            ),
          ),
        ),
      );

      deepStrictEqual(result, "ok");
      deepStrictEqual(
        (yield* Ref.get(reported)).map(({ kind, source }) => ({ source, kind })),
        [{ source: "AfterCommitTransport", kind: "after-commit-flush" }],
      );
    }),
  );
});

describe("deliverOnce", () => {
  it.effect("runs a redelivered envelope's handler once", () =>
    Effect.gen(function* () {
      const harness = yield* durableHarness;
      const outcomes = yield* Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.subscribeAfterCommit(Issued, (event) => harness.note(`handled:${event.id}`), {
          name: "notify",
        });
        yield* withUnitOfWork(bus.dispatch([Issued.make({ id: "a" })]));
        const envelope = yield* only(harness.recording.flushed);
        return [yield* deliverOnce(envelope), yield* deliverOnce(envelope)];
      }).pipe(Effect.provide(harness.layer));

      deepStrictEqual(outcomes, [Exit.succeed("delivered"), Exit.succeed("duplicate")]);
      deepStrictEqual(
        (yield* harness.timeline).filter((entry) => entry.startsWith("handled")),
        ["handled:a"],
      );
    }),
  );

  it.effect("runs the handler inside a unit of work of its own", () =>
    Effect.gen(function* () {
      const harness = yield* durableHarness;
      const inTransaction = yield* Ref.make(false);
      yield* Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.subscribeAfterCommit(
          Issued,
          () => Effect.flatMap(harness.isActive, (open) => Ref.set(inTransaction, open)),
          { name: "notify" },
        );
        const envelope = yield* only(bus.envelop([Issued.make({ id: "a" })]));
        yield* deliverOnce(envelope);
      }).pipe(Effect.provide(harness.layer));

      ok(yield* Ref.get(inTransaction));
    }),
  );
});
