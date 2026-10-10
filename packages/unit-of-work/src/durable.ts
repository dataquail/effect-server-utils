import type { Event } from "@effect-server-utils/cqrs";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { PersistenceUnavailable } from "./persistence-unavailable.js";

/**
 * Where a durable unit of work puts after-commit reactions instead of running
 * them: the host's half of a transactional outbox.
 *
 * `enqueue` runs inside the publisher's transaction, so the envelopes commit or
 * vanish with the work that produced them — that is the whole durability
 * argument, and why it is a host port rather than something this package could
 * do over a generic driver. `flush` runs once the transaction has committed, to
 * hand the same envelopes to whatever delivers them. A flush that fails or never
 * happens (a crash between commit and flush) loses nothing: the rows are still
 * there for a host's sweeper to re-flush.
 *
 * Neither declares a failure. One in `enqueue` dies and so rolls the
 * publisher's transaction back; one in `flush` is isolated and reported, since
 * the publisher is already durable.
 */
export interface AfterCommitTransportShape {
  readonly enqueue: (envelopes: ReadonlyArray<Event.Envelope>) => Effect.Effect<void>;
  readonly flush: (envelopes: ReadonlyArray<Event.Envelope>) => Effect.Effect<void>;
}

export class AfterCommitTransport extends Context.Service<
  AfterCommitTransport,
  AfterCommitTransportShape
>()("@effect-server-utils/unit-of-work/AfterCommitTransport") {}

/**
 * The record of which envelopes have already been delivered, consulted inside
 * the unit of work a delivery runs in.
 *
 * `claim` answers true exactly once per `(eventId, handler)` and records the
 * claim in the open transaction. A handler that fails rolls the claim back with
 * everything else it wrote, so a retry claims again; one that commits holds it,
 * so a redelivery claims nothing. That turns an at-least-once queue into
 * exactly-once for every effect the handler commits through the same
 * transaction — and only those: a side effect outside it (an email) can still
 * repeat if the commit after it fails.
 */
export interface DeliveryLedgerShape {
  readonly claim: (
    eventId: string,
    handler: string,
  ) => Effect.Effect<boolean, PersistenceUnavailable>;
}

export class DeliveryLedger extends Context.Service<DeliveryLedger, DeliveryLedgerShape>()(
  "@effect-server-utils/unit-of-work/DeliveryLedger",
) {}
