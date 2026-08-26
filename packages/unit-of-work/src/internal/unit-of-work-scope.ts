import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";

/**
 * Present exactly while a unit of work is open, and the carrier for the state
 * that lives as long as one.
 *
 * Its presence is the answer to "am I inside a unit of work?", which is what the
 * deferral sink fails fast on — deferring with no unit of work open almost always
 * means a forgotten boundary, and the alternative is worse than a defect: the
 * events would buffer onto something nothing will ever drain.
 *
 * `deferred` accumulates drain effects during the unit of work; the outermost run
 * runs them once its scope has committed, and a rolled-back nested scope truncates
 * the list back to its length on entry so reactions to work that was undone never
 * fire. Effects rather than events because the sink resolves the bus at the moment
 * it takes ownership — the fiber that dispatched is the one that certainly has one
 * — instead of hoping to find the same bus again at drain time.
 *
 * Internal on purpose: it is the sink's private bookkeeping, and the only reason a
 * consumer ever wanted it was to hand-roll a pass-through unit of work, which
 * `@effect-server-utils/unit-of-work/testing` now supplies.
 */
export class UnitOfWorkScope extends Context.Service<
  UnitOfWorkScope,
  { readonly deferred: Ref.Ref<ReadonlyArray<Effect.Effect<void>>> }
>()("@effect-server-utils/unit-of-work/UnitOfWorkScope") {}
