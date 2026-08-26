import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type * as Event from "./event.js";

/**
 * Where a deferred reaction is placed to run.
 *
 * The bus knows which handlers answer an event, what to name their spans, and
 * that their failures must be isolated. It does not know what a "boundary" is —
 * so a sink hands `drain` this, and the bus wraps each handler in it. A sink
 * over a unit of work passes one that opens a fresh transaction per handler,
 * which is what keeps a reaction from being able to undo the work it reacted to.
 *
 * The return channels are `unknown` because a boundary may widen both: opening
 * a transaction can fail in ways the handler never declared. `drain` catches the
 * whole cause either way.
 */
export type ReactionBoundary = (reaction: Effect.Effect<void>) => Effect.Effect<unknown, unknown>;

/**
 * Somewhere to hold events until the boundary that produced them completes.
 *
 * This is the package's one concession to transactions, and it is deliberately
 * ignorant of them: a sink is told "these happened" and promises to call
 * `EventBus.drain` for them later, or never, if whatever it was waiting on did
 * not succeed. Nothing here names a commit, a savepoint, or a connection.
 *
 * Optional. With no sink in context an `EventBus` still works — see `dispatch`,
 * where "once the boundary completes" degenerates to "once the immediate
 * handlers have run". `@effect-server-utils/unit-of-work` installs the sink that
 * makes `subscribeAfterCommit` mean what its name says; a host with no
 * transactions to defer onto installs nothing and writes the same handlers.
 */
export interface DeferralSinkShape {
  /**
   * Takes ownership of these events. Called before any of a dispatch's immediate
   * handlers run, so a sink with no boundary open reports that before half the
   * dispatch has executed rather than after.
   */
  readonly defer: (events: ReadonlyArray<Event.Base>) => Effect.Effect<void>;
}

export class DeferralSink extends Context.Service<DeferralSink, DeferralSinkShape>()(
  "@effect-server-utils/cqrs/DeferralSink",
) {}
