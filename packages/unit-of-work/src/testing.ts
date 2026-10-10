import type { DeferralSink, Event } from "@effect-server-utils/cqrs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { AfterCommitTransport, type AfterCommitTransportShape, DeliveryLedger } from "./durable.js";
import type { PersistenceUnavailable } from "./persistence-unavailable.js";
import {
  TransactionDriver,
  type TransactionDriverShape,
  type TransactionFailed,
} from "./transaction-driver.js";
import { makeUnitOfWork, type UnitOfWork } from "./unit-of-work.js";

/**
 * In-memory stand-ins for a host's atomicity primitive, kept out of the main
 * barrel so nothing in a production import graph names them. Reach them at
 * `@effect-server-utils/unit-of-work/testing`, from a test.
 */

/** Which kind of scope the unit of work asked a driver for. */
export type RecordedScope = "transaction" | "savepoint";

/**
 * A driver that opens no real scope but reports one active for the duration of
 * the effect it wraps, which is the whole of what the unit of work reads back
 * from a driver — and records which kind it was asked for.
 *
 * The depth is a counter rather than a flag, so a scope closing does not report
 * the enclosing one closed too; that is what `run` reads to decide whether to
 * nest.
 */
export const makeRecordingDriver: Effect.Effect<{
  readonly driver: TransactionDriverShape;
  readonly scopes: Effect.Effect<ReadonlyArray<RecordedScope>>;
}> = Effect.gen(function* () {
  const scopes = yield* Ref.make<ReadonlyArray<RecordedScope>>([]);
  const depth = yield* Ref.make(0);

  const enter =
    (scope: RecordedScope) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Ref.update(scopes, (prev) => [...prev, scope]).pipe(
        Effect.andThen(Ref.update(depth, (open) => open + 1)),
        Effect.andThen(effect),
        Effect.ensuring(Ref.update(depth, (open) => open - 1)),
      );

  return {
    driver: TransactionDriver.of({
      withTransaction: enter("transaction"),
      withSavepoint: enter("savepoint"),
      isActive: Effect.map(Ref.get(depth), (open) => open > 0),
    }),
    scopes: Ref.get(scopes),
  };
});

/** The same driver as a Layer, for tests that never inspect which scope was opened. */
export const RecordingTransactionDriver: Layer.Layer<TransactionDriver> = Layer.effect(
  TransactionDriver,
  Effect.map(makeRecordingDriver, ({ driver }) => driver),
);

/** A driver whose scope always fails the way a host adapter would report it. */
export const driverFailingWith = (
  error: TransactionFailed | PersistenceUnavailable,
): Layer.Layer<TransactionDriver> =>
  Layer.succeed(
    TransactionDriver,
    TransactionDriver.of({
      withTransaction: () => Effect.fail(error),
      withSavepoint: () => Effect.fail(error),
      isActive: Effect.succeed(false),
    }),
  );

/**
 * The whole boundary over the in-memory driver: real re-entrancy, real
 * after-commit ordering, real discard-on-rollback, no datastore. What a unit
 * test of a use case wires when its repositories are fakes that never consult a
 * transaction.
 *
 * The point of using the real `makeUnitOfWork` rather than a hand-rolled
 * pass-through is that it installs the real `DeferralSink` too, so a subject
 * that dispatches an event gets the same delivery it would get in production —
 * including a rolled-back scope discarding what it buffered, which is the
 * behaviour a hand-rolled double is most likely to get wrong.
 */
export const PassThroughUnitOfWork: Layer.Layer<UnitOfWork | DeferralSink> = makeUnitOfWork().pipe(
  Layer.provide(RecordingTransactionDriver),
);

/**
 * A transport that keeps what it is handed: what a durable unit of work
 * enqueued inside its transaction, and what it flushed after commit. Nothing is
 * delivered — a test that wants delivery hands a flushed envelope to
 * `deliverOnce` itself, which is the shape of the real contract.
 *
 * Enqueued envelopes are never taken back, since there is no transaction here
 * to roll back; compare `flushed`, which only ever holds committed work.
 */
export const makeRecordingTransport: Effect.Effect<{
  readonly transport: AfterCommitTransportShape;
  readonly layer: Layer.Layer<AfterCommitTransport>;
  readonly enqueued: Effect.Effect<ReadonlyArray<Event.Envelope>>;
  readonly flushed: Effect.Effect<ReadonlyArray<Event.Envelope>>;
}> = Effect.gen(function* () {
  const enqueued = yield* Ref.make<ReadonlyArray<Event.Envelope>>([]);
  const flushed = yield* Ref.make<ReadonlyArray<Event.Envelope>>([]);
  const transport = AfterCommitTransport.of({
    enqueue: (envelopes) => Ref.update(enqueued, (prev) => [...prev, ...envelopes]),
    flush: (envelopes) => Ref.update(flushed, (prev) => [...prev, ...envelopes]),
  });
  return {
    transport,
    layer: Layer.succeed(AfterCommitTransport, transport),
    enqueued: Ref.get(enqueued),
    flushed: Ref.get(flushed),
  };
});

/**
 * A ledger held in memory. Its claims survive a rolled-back unit of work, which
 * a real one's must not — so it proves a redelivery is skipped, and nothing
 * about a retry after a failure.
 */
export const InMemoryDeliveryLedger: Layer.Layer<DeliveryLedger> = Layer.effect(
  DeliveryLedger,
  Effect.map(Ref.make<ReadonlySet<string>>(new Set()), (claimed) =>
    DeliveryLedger.of({
      claim: (eventId, handler) =>
        Ref.modify(claimed, (prev) => {
          const key = `${eventId}\u0000${handler}`;
          return prev.has(key) ? [false, prev] : [true, new Set([...prev, key])];
        }),
    }),
  ),
);
