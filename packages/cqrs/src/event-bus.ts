import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
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

/** The `drain` boundary a host that owns none supplies: run the reaction as it is. */
const inline: ReactionBoundary = (reaction) => reaction;

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
      const afterCommit = yield* Ref.make<Registry>(new Map());
      const extractors = options.spanAttributes ?? {};
      // Unbounded so a broadcast never blocks the drain. A bounded buffer would
      // either block the publisher or drop silently; a consumer that stops
      // consuming shows up as its own subscription queue growing, which is a
      // diagnosable bug rather than lost events.
      const broadcasts = yield* PubSub.unbounded<Event.Base>();

      const subscribe: EventBusShape["subscribe"] = (event, handler) =>
        register(immediate, event.tag, handler as EventHandler);

      const subscribeAfterCommit: EventBusShape["subscribeAfterCommit"] = (event, handler) =>
        register(afterCommit, event.tag, handler as EventHandler);

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
          for (const [index, handler] of (registered.get(event._tag) ?? []).entries()) {
            yield* boundary(handler(event)).pipe(
              Effect.catchCause((cause) =>
                reportUnhandled({
                  // Handlers register as bare functions, so the position in the
                  // tag's registration order is the only name one has.
                  source: `${event._tag}#${index}`,
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
        dispatch,
        drain,
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
