import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { DeferralSink, type ReactionBoundary } from "./deferral.js";
import type * as Event from "./event.js";
import { reportUnhandled } from "./unhandled-failures.js";

export type EventHandler = (event: Event.Base) => Effect.Effect<void>;

/**
 * One bus, three delivery contracts, chosen at **subscription** rather than at
 * dispatch.
 *
 * That is the whole design. A producer knows what happened; it does not know who
 * is listening, and in a layered application it is often forbidden to. Letting it
 * pick the consistency model would mean deciding, on behalf of consumers it
 * cannot name, whether their failure may undo its own write. So `dispatch` says
 * only "these events happened", and each subscriber declares what it needs — which
 * also lets one event serve an immediate consumer and an eventual one at once.
 *
 * What "eventual" is eventual *on* is not this package's business. A
 * `DeferralSink` in context owns that; absent one, the bus runs the deferred
 * surfaces itself.
 */
export interface EventBusShape {
  /**
   * Publishes to every surface at once.
   *
   * Deferred surfaces are handed to a `DeferralSink` if one is in context, and
   * run at the end of this dispatch if none is. Either way a producer writes the
   * same call and a subscriber gets the contract it asked for.
   */
  readonly dispatch: (events: ReadonlyArray<Event.Base>) => Effect.Effect<void>;
  /**
   * Runs in the publisher's fiber, in registration order, inside whatever
   * boundary the publisher is in: the handler's writes commit with the
   * publisher's and its failure rolls the publisher back.
   *
   * This is the contract for a reaction that is part of the same logical
   * operation — a wallet must not exist without its organization.
   */
  readonly subscribe: <E extends Event.Any>(
    event: E,
    handler: (event: Event.Type<E>) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
  /**
   * Runs once the publisher's boundary has completed, each handler in a boundary
   * of its own, its failure logged and isolated.
   *
   * The failure direction is the opposite of `subscribe`, by design: the producer
   * is already durable, so a reaction must not undo it. Handlers are therefore
   * expected to be idempotent and independently retryable.
   *
   * With no `DeferralSink` in context there is no boundary to wait on, so these
   * run at the end of the dispatch that produced them — still after every
   * immediate handler, still isolated. A handler written against this surface is
   * correct in both wirings, which is what lets a host adopt a unit of work later
   * without revisiting one of them.
   */
  readonly subscribeAfterCommit: <E extends Event.Any>(
    event: E,
    handler: (event: Event.Type<E>) => Effect.Effect<void>,
    options?: AfterCommitOptions,
  ) => Effect.Effect<void>;
  /**
   * Subscribes to the events of the given tags and hands back their stream. Only
   * events broadcast while subscribed arrive — nothing is replayed, and nothing
   * accumulates for a stream no one is reading.
   *
   * Subscribing is an effect rather than a property of the stream because *when*
   * it happens is observable: a consumer that subscribed lazily, on first pull,
   * would miss everything broadcast between its construction and that pull. The
   * subscription lives as long as the ambient scope.
   *
   * A third surface rather than a flag on `subscribeAfterCommit` because the
   * delivery contracts genuinely differ: an after-commit handler is awaited and
   * its failure isolated, while a stream consumer may be a process manager that
   * runs for days and must never hold up a drain.
   */
  readonly stream: (
    tags: ReadonlyArray<string>,
  ) => Effect.Effect<Stream.Stream<Event.Base>, never, Scope.Scope>;
  /**
   * Runs everything a dispatch deferred: the broadcast to stream consumers, then
   * each after-commit handler, its failure isolated and reported.
   *
   * `boundary` is where a sink says what a deferred reaction should run inside —
   * a sink over a unit of work passes one that opens a fresh transaction per
   * handler. It defaults to running the handler as-is, which is the no-sink case.
   *
   * Called by a `DeferralSink` once whatever it was waiting on has succeeded, and
   * by `dispatch` itself when no sink is installed. Nothing else should call it:
   * a second call re-runs every handler.
   */
  readonly drain: (
    events: ReadonlyArray<Event.Base>,
    boundary?: ReactionBoundary,
  ) => Effect.Effect<void>;
  /**
   * Publishes to stream consumers only, awaiting nothing. `drain` calls this;
   * it is exposed because a host driving delivery from a durable log has the
   * broadcast and the handler drain arrive at different times.
   */
  readonly broadcast: (events: ReadonlyArray<Event.Base>) => Effect.Effect<void>;
  /**
   * Seals these events for durable delivery: one `Event.Envelope` per event per
   * after-commit subscription, each event's payload encoded through its own
   * schema. An event no after-commit subscription answers yields nothing, so a
   * durable host writes nothing for it.
   *
   * Every subscription it seals for must be named — the name is the envelope's
   * address, and a positional one would silently re-route in-flight envelopes
   * the next time registration order changed. An unnamed one is a defect,
   * `UnnamedAfterCommitSubscription`.
   */
  readonly envelop: (
    events: ReadonlyArray<Event.Base>,
  ) => Effect.Effect<ReadonlyArray<Event.Envelope>>;
  /**
   * Runs the one subscription an envelope is addressed to, inside `boundary`,
   * and reports how it ended rather than failing — a queue consumer acks on
   * success and retries otherwise, and a failure here is the input to that
   * decision, not something to propagate.
   *
   * An envelope no registered subscription answers, or whose payload no longer
   * decodes, fails with `UndeliverableEnvelope`: retrying it cannot help. Every
   * failure is also reported, exactly as a failure in `drain` is.
   */
  readonly deliver: <A = void, E = never, R = never>(
    envelope: Event.Envelope,
    boundary?: (reaction: Effect.Effect<void>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<Exit.Exit<A, E | UndeliverableEnvelope>, never, R>;
}

export interface AfterCommitOptions {
  /**
   * The subscription's stable identity, unique among one event's after-commit
   * subscriptions. Optional in-process, where it only names the handler in
   * spans and failure reports; required by a durable transport, which addresses
   * envelopes and records deliveries by it.
   */
  readonly name: string;
}

/** Two after-commit subscriptions to one event claimed the same name. */
export class DuplicateSubscriptionName extends Schema.TaggedError<DuplicateSubscriptionName>()(
  "DuplicateSubscriptionName",
  { tag: Schema.String, name: Schema.String },
) {
  override get message(): string {
    return `[EventBus] more than one after-commit subscription to '${this.tag}' is named '${this.name}'`;
  }
}

/** An event was sealed for durable delivery while one of its subscriptions had no name. */
export class UnnamedAfterCommitSubscription extends Schema.TaggedError<UnnamedAfterCommitSubscription>()(
  "UnnamedAfterCommitSubscription",
  { tag: Schema.String },
) {
  override get message(): string {
    return `[EventBus] '${this.tag}' has an after-commit subscription with no name, so it cannot be delivered durably. Pass { name } to subscribeAfterCommit.`;
  }
}

/** An envelope that no retry can deliver. */
export class UndeliverableEnvelope extends Schema.TaggedError<UndeliverableEnvelope>()(
  "UndeliverableEnvelope",
  {
    eventId: Schema.String,
    tag: Schema.String,
    handler: Schema.String,
    reason: Schema.Literals(["unknown-subscription", "undecodable-payload"]),
  },
) {
  override get message(): string {
    return `[EventBus] envelope ${this.eventId} for '${this.tag}' → '${this.handler}' is undeliverable: ${this.reason}`;
  }
}

export class EventBus extends Context.Service<EventBus, EventBusShape>()(
  "@effect-server-utils/cqrs/EventBus",
) {}

type Registry = ReadonlyMap<string, ReadonlyArray<EventHandler>>;

const register = (registry: Ref.Ref<Registry>, tag: string, handler: EventHandler) =>
  Ref.update(registry, (registered) => {
    const next = new Map(registered);
    next.set(tag, [...(registered.get(tag) ?? []), handler]);
    return next;
  });

/**
 * An after-commit subscription keeps its event definition beside its handler:
 * the schema is what seals a payload into an envelope and opens it again, so a
 * bus that has a subscription to an event already has everything needed to
 * deliver it durably. No separate event registry to keep in step.
 */
interface AfterCommitSubscription {
  readonly event: Event.Any;
  readonly name: string | undefined;
  readonly handler: EventHandler;
}

type AfterCommitRegistry = ReadonlyMap<string, ReadonlyArray<AfterCommitSubscription>>;

/** The `drain` boundary a host that owns none supplies: run the reaction as it is. */
const inline: ReactionBoundary = (reaction) => reaction;

const jsonCodec = (event: Event.Any) =>
  Schema.toCodecJson(event.schema as Schema.Codec<unknown, unknown>);

/** Time-ordered, so an outbox keyed on it is also ordered by when events happened. */
const uuidV7 = (timestampMillis: number): string => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(timestampMillis / 2 ** (8 * (5 - i))) & 0xff;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Builds the bus, optionally with per-event span-attribute extractors — pass the
 * merged contributions of every module that owns events.
 *
 * Subscriptions are registered while layers are built, so the registries are only
 * mutated during composition and are read-only by the time anything dispatches.
 */
export const makeEventBus = (
  options: { readonly spanAttributes?: Event.SpanAttributes } = {},
): Layer.Layer<EventBus> =>
  Layer.effect(
    EventBus,
    Effect.gen(function* () {
      const immediate = yield* Ref.make<Registry>(new Map());
      const afterCommit = yield* Ref.make<AfterCommitRegistry>(new Map());
      const extractors = options.spanAttributes ?? {};
      // Unbounded so a broadcast never blocks the drain. A bounded buffer would
      // either block the publisher or drop silently; a consumer that stops
      // consuming shows up as its own subscription queue growing, which is a
      // diagnosable bug rather than lost events.
      const broadcasts = yield* PubSub.unbounded<Event.Base>();

      const subscribe: EventBusShape["subscribe"] = (event, handler) =>
        register(immediate, event.tag, handler as EventHandler);

      const subscribeAfterCommit: EventBusShape["subscribeAfterCommit"] = (
        event,
        handler,
        subscription,
      ) =>
        Effect.flatMap(Ref.get(afterCommit), (registered) => {
          const existing = registered.get(event.tag) ?? [];
          const name = subscription?.name;
          if (name !== undefined && existing.some((entry) => entry.name === name)) {
            return Effect.die(new DuplicateSubscriptionName({ tag: event.tag, name }));
          }
          const next = new Map(registered);
          next.set(event.tag, [...existing, { event, name, handler: handler as EventHandler }]);
          return Ref.set(afterCommit, next);
        });

      const broadcast: EventBusShape["broadcast"] = (events) =>
        Effect.asVoid(PubSub.publishAll(broadcasts, events));

      const drain: EventBusShape["drain"] = Effect.fnUntraced(function* (
        events: ReadonlyArray<Event.Base>,
        boundary: ReactionBoundary = inline,
      ): Effect.fn.Return<void> {
        // Stream consumers first, and not awaited: a process manager may run for
        // days, so holding the drain for one would stall every later reaction.
        // A handler failing below must not keep an event from reaching them.
        yield* broadcast(events);

        const registered = yield* Ref.get(afterCommit);
        for (const event of events) {
          for (const [index, subscription] of (registered.get(event._tag) ?? []).entries()) {
            yield* boundary(subscription.handler(event)).pipe(
              Effect.catchCause((cause) =>
                reportUnhandled({
                  // An unnamed handler registered as a bare function, so its
                  // position in the tag's registration order is the only name
                  // it has.
                  source: subscription.name ?? `${event._tag}#${index}`,
                  kind: "after-commit-handler",
                  eventTag: event._tag,
                  cause,
                }),
              ),
              Effect.withSpan(`event.afterCommit.${event._tag}`),
            );
          }
        }
      });

      const envelop: EventBusShape["envelop"] = Effect.fnUntraced(function* (
        events: ReadonlyArray<Event.Base>,
      ): Effect.fn.Return<ReadonlyArray<Event.Envelope>> {
        const registered = yield* Ref.get(afterCommit);
        const envelopes: Array<Event.Envelope> = [];
        for (const event of events) {
          const subscriptions = registered.get(event._tag) ?? [];
          const [first] = subscriptions;
          if (first === undefined) continue;

          const occurredAt = yield* Clock.currentTimeMillis;
          const eventId = uuidV7(occurredAt);
          // An event that fails its own schema was constructed around `make`;
          // that is a bug in the publisher, not a condition a caller handles.
          const payload = yield* Effect.orDie(
            Schema.encodeUnknownEffect(jsonCodec(first.event))(event),
          );

          for (const subscription of subscriptions) {
            if (subscription.name === undefined) {
              return yield* Effect.die(new UnnamedAfterCommitSubscription({ tag: event._tag }));
            }
            envelopes.push({
              eventId,
              tag: event._tag,
              handler: subscription.name,
              occurredAt: new Date(occurredAt).toISOString(),
              payload,
            });
          }
        }
        return envelopes;
      });

      const deliver = Effect.fnUntraced(function* (
        envelope: Event.Envelope,
        boundary: (
          reaction: Effect.Effect<void>,
        ) => Effect.Effect<unknown, unknown, unknown> = inline,
      ): Effect.fn.Return<Exit.Exit<unknown, unknown>, never, unknown> {
        const undeliverable = (reason: UndeliverableEnvelope["reason"]) =>
          new UndeliverableEnvelope({
            eventId: envelope.eventId,
            tag: envelope.tag,
            handler: envelope.handler,
            reason,
          });

        const subscription = (yield* Ref.get(afterCommit))
          .get(envelope.tag)
          ?.find((entry) => entry.name === envelope.handler);

        const outcome = yield* Effect.exit(
          (subscription === undefined
            ? Effect.fail(undeliverable("unknown-subscription"))
            : Schema.decodeEffect(jsonCodec(subscription.event))(envelope.payload).pipe(
                Effect.mapError(() => undeliverable("undecodable-payload")),
                Effect.flatMap((event) => boundary(subscription.handler(event as Event.Base))),
              )
          ).pipe(
            Effect.withSpan(`event.deliver.${envelope.tag}`, {
              attributes: { "event.id": envelope.eventId, "event.handler": envelope.handler },
            }),
          ),
        );

        if (Exit.isFailure(outcome)) {
          yield* reportUnhandled({
            source: envelope.handler,
            kind: "after-commit-handler",
            eventTag: envelope.tag,
            cause: outcome.cause,
          });
        }
        return outcome;
      }) as EventBusShape["deliver"];

      const dispatch: EventBusShape["dispatch"] = Effect.fnUntraced(function* (
        events: ReadonlyArray<Event.Base>,
      ): Effect.fn.Return<void> {
        const sink = yield* Effect.serviceOption(DeferralSink);

        // Handed over before a single handler runs. A sink with nothing open to
        // defer onto — a dispatch that forgot its boundary — says so here, while
        // the dispatch is still whole; the alternative reports it after half of
        // it has already executed. Buffering early costs nothing, because a
        // boundary that does not succeed never drains what it took.
        if (Option.isSome(sink)) yield* sink.value.defer(events);

        const registered = yield* Ref.get(immediate);
        for (const event of events) {
          const forTag = registered.get(event._tag) ?? [];
          const extractor = extractors[event._tag];
          // Routing by tag is what guarantees this extractor was written for
          // this event's type, which is what the `never` argument gives up.
          const extracted: Record<string, Event.SpanAttributeValue> =
            extractor !== undefined ? extractor(event as never) : {};

          yield* Effect.forEach(forTag, (handler) => handler(event), {
            discard: true,
          }).pipe(
            Effect.withSpan(`event.${event._tag}`, {
              attributes: {
                "event.tag": event._tag,
                "event.handler.count": forTag.length,
                ...extracted,
              },
            }),
          );
        }

        // Nobody owns a boundary, so "once it completes" is now — after every
        // immediate handler, which is the part of the ordering that is a promise
        // rather than an artefact of where the commit lands.
        if (Option.isNone(sink)) yield* drain(events);
      });

      return EventBus.of({
        broadcast,
        deliver,
        dispatch,
        drain,
        envelop,
        stream: (tags) => {
          const wanted = new Set(tags);
          return Effect.map(PubSub.subscribe(broadcasts), (subscription) =>
            Stream.filter(Stream.fromSubscription(subscription), (event) => wanted.has(event._tag)),
          );
        },
        subscribe,
        subscribeAfterCommit,
      });
    }),
  );
