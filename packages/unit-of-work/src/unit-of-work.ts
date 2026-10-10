import {
  DeferralSink,
  type Event,
  EventBus,
  type EventBusShape,
  type UndeliverableEnvelope,
  UnhandledFailures,
} from "@effect-server-utils/cqrs";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { AfterCommitTransport, type AfterCommitTransportShape, DeliveryLedger } from "./durable.js";
import { UnitOfWorkScope } from "./internal/unit-of-work-scope.js";
import type { PersistenceUnavailable } from "./persistence-unavailable.js";
import { TransactionDriver, type TransactionFailed } from "./transaction-driver.js";

/**
 * Something was deferred without a unit of work open. A defect rather than a
 * failure — no publisher declares it and none could handle it — but a tagged one,
 * so a test can name the condition instead of matching on a sentence.
 */
export class EventDispatchedOutsideUnitOfWork extends Schema.TaggedError<EventDispatchedOutsideUnitOfWork>()(
  "EventDispatchedOutsideUnitOfWork",
  { tags: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `EventBus.dispatch requires a unit of work: no UnitOfWorkScope in scope when dispatching ${this.tags
      .map((tag) => `'${tag}'`)
      .join(", ")} (did you forget withUnitOfWork?)`;
  }
}

/** A sink was handed events by something that is not an `EventBus`. */
export class DeferralWithoutEventBus extends Schema.TaggedError<DeferralWithoutEventBus>()(
  "DeferralWithoutEventBus",
  { tags: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `UnitOfWork's DeferralSink was called with no EventBus in context, so ${this.tags
      .map((tag) => `'${tag}'`)
      .join(", ")} would have nothing to drain them. Only an EventBus should call defer.`;
  }
}

/**
 * "Run this effect inside a single unit of work" — the atomicity boundary for a
 * logical operation. Every repository write inside it commits together or is
 * discarded together, and every immediate event subscriber inherits that same
 * boundary.
 *
 * Use cases depend on this port and never on a datastore, which is what lets
 * them be unit-tested against a pass-through implementation.
 *
 * The requirement channel is unchanged. The boundary provides its scope handle
 * ambiently rather than through `R`, so an effect handed to `run` never declared
 * a requirement for one and there is nothing here to discharge.
 */
export interface UnitOfWorkShape {
  readonly run: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | TransactionFailed | PersistenceUnavailable, R>;
}

export class UnitOfWork extends Context.Service<UnitOfWork, UnitOfWorkShape>()(
  "@effect-server-utils/unit-of-work/UnitOfWork",
) {}

/**
 * Builds the unit of work over a host's atomicity primitive, and with it the
 * `DeferralSink` that gives `EventBus.subscribeAfterCommit` its commit.
 *
 * The two ship together because they are one decision: what "after" means is the
 * boundary's to define, and a host that installs the boundary has answered it.
 * An `EventBus` alone still works — it just runs its deferred surfaces at the end
 * of each dispatch, having no commit to wait for.
 *
 * `run` is re-entrant. A bare call opens a scope; a call already inside one
 * nests instead of reaching for a second connection. Whether a nested failure
 * is fatal to the whole operation is then the caller's choice — catching it
 * discards only the nested scope, letting it propagate discards everything.
 */
export const makeUnitOfWork = (): Layer.Layer<
  UnitOfWork | DeferralSink,
  never,
  TransactionDriver
> => Layer.effectContext(buildUnitOfWork(inProcess));

/**
 * The same boundary, with after-commit reactions made durable: instead of
 * buffering them in memory, the sink seals each event into one envelope per
 * named after-commit subscription and hands them to the host's
 * `AfterCommitTransport` *inside* the transaction, then flushes them once it
 * commits. A crash between the two loses nothing a sweeper cannot find.
 *
 * A separate constructor rather than an option, because it is a decision made
 * once for a whole application — every after-commit subscription in the process
 * is delivered the same way — and the extra requirement in the layer's type is
 * what keeps it from being half-made. Immediate subscribers are untouched, and
 * stream consumers still receive each event in-process, after the flush.
 */
export const makeDurableUnitOfWork = (): Layer.Layer<
  UnitOfWork | DeferralSink,
  never,
  TransactionDriver | AfterCommitTransport
> =>
  Layer.effectContext(
    Effect.flatMap(AfterCommitTransport, (transport) => buildUnitOfWork(durable(transport))),
  );

/**
 * What the sink buffers for one dispatch, given the bus that dispatched it:
 * whatever it does now runs inside the publisher's transaction, and the effect
 * it returns runs once that transaction has committed.
 */
type Deferral = (
  bus: EventBusShape,
  events: ReadonlyArray<Event.Base>,
  run: UnitOfWorkShape["run"],
) => Effect.Effect<Effect.Effect<void>>;

// Each reaction in a unit of work of its own, so its failure is isolated: the
// producer already committed and must not be undone by something reacting to it.
const inProcess: Deferral = (bus, events, run) => Effect.succeed(bus.drain(events, run));

const durable =
  (transport: AfterCommitTransportShape): Deferral =>
  (bus, events) =>
    Effect.flatMap(bus.envelop(events), (envelopes) =>
      // Nothing to seal, nothing written: a dispatch no after-commit
      // subscription answers costs the publisher's transaction no statement.
      envelopes.length === 0
        ? Effect.succeed(bus.broadcast(events))
        : Effect.as(
            transport.enqueue(envelopes),
            transport
              .flush(envelopes)
              .pipe(Effect.catchCause(reportFlushFailure), Effect.andThen(bus.broadcast(events))),
          ),
    );

const reportFlushFailure = (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
  Effect.logError("Unhandled failure in after-commit-flush 'AfterCommitTransport'", cause).pipe(
    Effect.andThen(
      Effect.flatMap(Effect.serviceOption(UnhandledFailures), (failures) =>
        Option.isNone(failures)
          ? Effect.void
          : failures.value.report({
              source: "AfterCommitTransport",
              kind: "after-commit-flush",
              eventTag: undefined,
              cause,
            }),
      ),
    ),
  );

const buildUnitOfWork = (deferral: Deferral) =>
  Effect.gen(function* () {
    const driver = yield* TransactionDriver;

    const runOutermost = Effect.fnUntraced(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.fn.Return<A, E | TransactionFailed | PersistenceUnavailable, R> {
      const deferred = yield* Ref.make<ReadonlyArray<Effect.Effect<void>>>([]);
      // Sequencing is the commit guarantee: a failed scope never reaches the
      // drain, so reactions to work that was discarded never fire.
      const result = yield* driver.withTransaction(
        Effect.provideService(effect, UnitOfWorkScope, { deferred }),
      );
      // Uninterruptible: the transaction has committed, so an interrupt
      // arriving now (a caller hanging up, a shutdown) would otherwise discard
      // every reaction to work that is already durable. The caller was already
      // waiting for this, so the only thing given up is the ability to cancel
      // reactions that must happen anyway.
      yield* Effect.uninterruptible(
        Effect.forEach(yield* Ref.get(deferred), (drain) => drain, { discard: true }),
      );
      return result;
    });

    const runNested = Effect.fnUntraced(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      deferred: Ref.Ref<ReadonlyArray<Effect.Effect<void>>>,
    ): Effect.fn.Return<A, E | TransactionFailed | PersistenceUnavailable, R> {
      const lengthOnEntry = (yield* Ref.get(deferred)).length;
      return yield* driver
        .withSavepoint(Effect.provideService(effect, UnitOfWorkScope, { deferred }))
        .pipe(
          Effect.tapCause(() =>
            Ref.update(deferred, (buffered) => buffered.slice(0, lengthOnEntry)),
          ),
        );
    });

    const run = Effect.fnUntraced(function* <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.fn.Return<A, E | TransactionFailed | PersistenceUnavailable, R> {
      if (!(yield* driver.isActive)) return yield* runOutermost(effect);

      // Nested runs share the enclosing scope's buffer so the whole operation
      // drains once, at the outermost commit. A host that opened its own scope
      // without going through this boundary has none to inherit; it gets a
      // throwaway, which nothing will ever drain — but the sink resolved the
      // bus when it took the events, so what lands there is a real drain
      // effect and the only thing lost is when it runs.
      const enclosing = yield* Effect.serviceOption(UnitOfWorkScope);
      return yield* runNested(
        effect,
        Option.isSome(enclosing)
          ? enclosing.value.deferred
          : yield* Ref.make<ReadonlyArray<Effect.Effect<void>>>([]),
      );
    });

    /**
     * What makes an after-commit subscription mean "after commit".
     *
     * Stateless: it reads the scope `run` made ambient, so one instance serves
     * every unit of work in the process. It resolves the bus *here*, in the
     * fiber that dispatched, and buffers a closed-over drain — a bus wired
     * deeper than the boundary is therefore still the bus that gets drained,
     * where holding the bare events and looking one up at commit time would
     * find nothing and silently lose them.
     */
    const sink = DeferralSink.of({
      defer: Effect.fnUntraced(function* (events): Effect.fn.Return<void> {
        const tags = events.map((event) => event._tag);

        const scope = yield* Effect.serviceOption(UnitOfWorkScope);
        if (Option.isNone(scope)) {
          return yield* Effect.die(new EventDispatchedOutsideUnitOfWork({ tags }));
        }

        const bus = yield* Effect.serviceOption(EventBus);
        if (Option.isNone(bus)) {
          return yield* Effect.die(new DeferralWithoutEventBus({ tags }));
        }

        const afterCommit = yield* deferral(bus.value, events, run);
        yield* Ref.update(scope.value.deferred, (buffered) => [...buffered, afterCommit]);
      }),
    });

    return Context.make(UnitOfWork, UnitOfWork.of({ run })).pipe(Context.add(DeferralSink, sink));
  });

/**
 * The boundary combinator a use case applies at the end of its pipe, so the
 * unit of work is declared once and visibly rather than buried in an inner
 * block that dispatched event handlers would silently join.
 *
 * Named for the pattern, deliberately not `transactional` — that would leak the
 * SQL implementation the abstraction exists to hide. It demotes
 * `TransactionFailed` in this one place, which is what keeps the error channel
 * as clean as the name: a use case sees only `PersistenceUnavailable`.
 */
export const withUnitOfWork = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(UnitOfWork, (uow) => uow.run(effect)).pipe(
    Effect.catchTag("TransactionFailed", Effect.die),
  );

/**
 * Delivers one envelope the way a durable consumer must: the subscription it is
 * addressed to runs in a unit of work of its own, behind a `DeliveryLedger`
 * claim made in that same transaction. A redelivered envelope finds its claim
 * already committed and runs nothing.
 *
 * Never fails — the `Exit` is what a queue consumer acks or retries on. A
 * failed delivery has also been reported, exactly as an in-process one is.
 */
export const deliverOnce = (
  envelope: Event.Envelope,
): Effect.Effect<
  Exit.Exit<
    "delivered" | "duplicate",
    UndeliverableEnvelope | TransactionFailed | PersistenceUnavailable
  >,
  never,
  EventBus | UnitOfWork | DeliveryLedger
> =>
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const uow = yield* UnitOfWork;
    const ledger = yield* DeliveryLedger;
    return yield* bus.deliver(envelope, (reaction) =>
      uow.run(
        Effect.gen(function* () {
          if (!(yield* ledger.claim(envelope.eventId, envelope.handler))) {
            return "duplicate" as const;
          }
          yield* reaction;
          return "delivered" as const;
        }),
      ),
    );
  });
