// `./testing.js` is deliberately absent from this barrel and from the generated
// index: its serializability checks derive sample values with `fast-check`, a real
// runtime import that has no business in a consumer's production process. Reach it
// at `@effect-server-utils/cqrs/testing`, from a test.

// Declaring and handling messages: `Command.make`, `Command.group`, `Command.handlersOf`,
// and `Command.dispatcher` — a module's own dispatch surface, one method per tag it owns.
export * as Command from "./command.js";
export * as Query from "./query.js";

// Declaring an event: `Event.make`, the `Event.Base` a bus routes on, plus the
// per-event span-attribute registry a module contributes. The third message kind,
// and the one that fans out — many handlers may answer one event, where a command
// and a query each have exactly one.
export * as Event from "./event.js";

// A long-running process manager over after-commit events: `Saga.make` declares one,
// `Saga.runner` runs them for the life of its layer. Reach for an inbound event
// adapter first — a saga earns its state only when no single event decides.
export * as Saga from "./saga.js";

// Behaviour applied once around every dispatch instead of at each call site:
// `Middleware.span` (installed by default) and `Middleware.metrics`. A middleware
// may not change a message's success or error channels — that constraint is what
// lets the bus have a seam without weakening the types a caller reads off the
// message definition.
export * as Middleware from "./middleware.js";

// Where a failure goes when no caller is left to receive it: an eventual event
// handler or a saga, both of which run after their producer committed. Optional —
// absent it, those failures are logged exactly as before.
export {
  makeUnhandledFailures,
  type UnhandledFailure,
  type UnhandledFailureKind,
  UnhandledFailures,
  type UnhandledFailuresShape,
} from "./unhandled-failures.js";

// The application-wide buses a caller dispatches through, plus the routing table that
// composes per-module dispatchers into one. The Tags and their shapes are what ordinary
// code depends on; `makeCommandBus` / `makeQueryBus` / `mergeDispatchTables` take the
// whole table and belong only where an application is composed.
// The three ways a routing table can be wrong travel as tagged defects, so a
// host's boot check — or a test — can name the condition rather than match a
// message string.
export { CommandBus, type CommandBusShape, makeCommandBus } from "./command-bus.js";
export {
  type DispatchTable,
  DuplicateDispatchTag,
  mergeDispatchTables,
  MissingHandler,
  UnroutableTags,
} from "./dispatch-table.js";
export { makeQueryBus, QueryBus, type QueryBusShape } from "./query-bus.js";

// Where a dispatch's deferred surfaces go when something else owns the boundary
// they are waiting on. Optional, and deliberately ignorant of what a boundary is
// — a sink is told "these happened" and promises to call `EventBus.drain` for
// them later. `@effect-server-utils/unit-of-work` installs the one that makes
// after-commit mean after commit; with no sink in context the bus runs those
// surfaces itself, at the end of each dispatch.
export { DeferralSink, type DeferralSinkShape, type ReactionBoundary } from "./deferral.js";

// One bus; the *subscription* is the switch between consistency models, not the
// dispatch. `subscribe` runs in the publisher's fiber and can roll it back;
// `subscribeAfterCommit` runs once the publisher's boundary has completed, in a
// boundary of its own, and never can; `stream` feeds a saga and is never awaited.
// A producer says only that something happened, so one event can serve consumers
// that need different things.
export { EventBus, type EventBusShape, type EventHandler, makeEventBus } from "./event-bus.js";
