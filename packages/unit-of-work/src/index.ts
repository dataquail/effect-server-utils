// `./testing.js` is deliberately absent from this barrel and from the generated
// index: it holds in-memory stand-ins for a host's datastore, which have no
// business in a production import graph. Reach them at
// `@effect-server-utils/unit-of-work/testing`, from a test.

// The atomicity boundary a write-side use case declares once, at the end of its
// pipe. `withUnitOfWork` is the combinator; `UnitOfWork` is the port it resolves,
// so a use case can be unit-tested against a pass-through implementation without
// ever naming a datastore.
//
// `makeUnitOfWork` also installs the `DeferralSink` that
// `@effect-server-utils/cqrs`'s event bus looks for. That is not a side effect
// bolted on — it is the same decision: "after commit" has no meaning until
// something owns a commit, and this is the thing that owns one. A host that
// installs no unit of work still gets a working bus; its after-commit
// subscribers simply run at the end of each dispatch.
export {
  DeferralWithoutEventBus,
  EventDispatchedOutsideUnitOfWork,
  makeUnitOfWork,
  UnitOfWork,
  type UnitOfWorkShape,
  withUnitOfWork,
} from "./unit-of-work.js";

// The one thing a host must supply. Everything about how the boundary behaves —
// re-entrancy, deferral, drain ordering, failure isolation — is this package's;
// the SQL is the host's, and `TransactionDriver` is the whole of the seam
// between them.
export {
  TransactionDriver,
  type TransactionDriverShape,
  TransactionFailed,
} from "./transaction-driver.js";

// The transient-store failure a repository port names so a module's `domain/`
// can describe it without importing infrastructure. It sits here rather than in
// the CQRS package because the boundary's error channel is where it is actually
// load-bearing: `withUnitOfWork` demotes `TransactionFailed` and leaves this one
// standing, which is what makes "the store is momentarily unavailable" the only
// persistence failure a use case ever has to think about.
export { PersistenceUnavailable } from "./persistence-unavailable.js";
