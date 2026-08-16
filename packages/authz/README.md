# @effect-server-utils/authz

Declarative per-route authorization for [Effect](https://effect.website): policy checks registered
against `(resource, action)` pairs, per-request resource resolution, and composable check combinators.

```sh
pnpm add @effect-server-utils/authz effect
```

`effect` is a peer dependency.

## The shape of it

An inbound adapter calls one function:

```ts
const updateTodo = Effect.gen(function* () {
  yield* hasPermissions("todo", "update", todoId);
  // ...
});
```

Everything else is registration. The library never names an HTTP status, a session type, or an action
vocabulary — those are the host's, supplied once through a declaration-merged config seam.

## What you get

- **`AuthzConfig`** — the type-level seam. A host augments it once to say who the caller is, what a
  check may fail with, how a resolver reports absence, and which verbs a policy may be keyed on.
  Whether authorization is modelled as CRUD or as domain verbs is a modelling decision, and a library
  that shipped one would be imposing a taxonomy rather than providing a mechanism.
- **`Check`** — boolean predicates over `(caller, resource)`, expressed as Effects so they can reach a
  repository, plus `Check.any` (OR) and `Check.all` (AND) to compose them before the single lift to a
  denial at the boundary. `CallerCheck` is the narrower arity, so a check that inspects only the caller
  serves both scoped and unscoped resources.
- **`PolicyRegistry`** — which checks answer for which `(resource, action)`. Each module registers the
  pairs it owns; the composition root folds the contributions. Two modules claiming one pair is an
  error, not a silent overwrite.
- **`ResourceResolverRegistry`** — how a scoped resource is loaded before its checks run. Registration
  here is also the switch that decides whether a resource takes an id at all: scopedness is a property
  of the resource, not of the action.
- **`makeHasPermissions`** — pins the two things the DSL cannot supply for itself: the identity Tag to
  read the caller from, and the error a denial becomes.

## Configuring the seam

```ts
declare module "@effect-server-utils/authz/config" {
  interface AuthzConfig {
    caller: CurrentUser["Service"];
    checkFailure: PersistenceUnavailable;
    resourceMissing: NotFound;
    action: AppAction;
  }
}

declare module "@effect-server-utils/authz/resource-resolver-registry" {
  interface ResourceResolverMap {
    todo: { resourceType: Todo; idType: TodoId };
  }
}

declare module "@effect-server-utils/authz/policy-registry" {
  interface PolicyMap {
    todo: { view: CheckFor<"todo">; update: CheckFor<"todo"> };
    platform: { administer: CheckFor<"platform"> };
  }
}
```

`todo` is **scoped** — it appears in `ResourceResolverMap`, so every action on it requires an id and
its checks receive the loaded resource. `platform` is **unscoped** — absent from that map, so no action
on it takes an id, and `NotFound` never enters a call site's error channel.

## Registering policies

```ts
import * as Effect from "effect/Effect";
import {
  Check,
  makePolicyRegistry,
  makeResourceResolverRegistry,
} from "@effect-server-utils/authz";

const isOwner = (caller: Caller, todo: Todo) => Effect.succeed(todo.ownerId === caller.userId);
const isAdmin = (caller: Caller) => Effect.succeed(caller.roles.includes("admin"));

export const TodoPolicies = {
  todo: {
    view: Check.any(isOwner, isAdmin), // OR
    update: [isOwner, notArchived], // an array is AND-composed
  },
};

const registries = Layer.mergeAll(
  makePolicyRegistry([TodoPolicies, BillingPolicies]),
  makeResourceResolverRegistry({ todo: (id) => todoRepository.byId(id) }),
);
```

## Wiring the adapter

```ts
import { makeHasPermissions } from "@effect-server-utils/authz";

export const hasPermissions = makeHasPermissions({
  caller: CurrentUser, // a Context.Key is already an Effect
  forbidden: (message) => new Forbidden({ message }),
});
```

Each call opens an `authz.hasPermissions.<resource>.<action>` span, and a policy returning `false`
becomes your denial error.

## Documentation

Full documentation: <https://dataquail.github.io/effect-server-utils>

## License

MIT
