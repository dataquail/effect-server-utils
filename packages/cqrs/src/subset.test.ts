import { assert, describe, it } from "@effect/vitest";
import { Query } from "@effect-server-utils/cqrs";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const FindUserRoles = Query.make("FindUserRoles", {
  payload: { userId: Schema.String },
  success: Schema.Struct({ roles: Schema.Array(Schema.String) }),
});

const FindAllUsers = Query.make("FindAllUsers", {
  success: Schema.Struct({ count: Schema.Finite }),
});

const group = Query.group(FindUserRoles, FindAllUsers);

const handlers = Query.handlersOf(group, {
  FindUserRoles: ({ userId }) => Effect.succeed({ roles: [`admin:${userId}`] }),
  FindAllUsers: () => Effect.succeed({ count: 2 }),
});

describe("Query.subsetOf", () => {
  // The property everything rests on: the subset reuses the very message objects
  // the full group registered handlers for, so the transport finds them.
  it.effect("dispatches through handlers registered by the whole group", () =>
    Effect.gen(function* () {
      const published = Query.subsetOf(group, "FindUserRoles");
      const dispatch = yield* Query.dispatcher(published);

      const result = yield* dispatch.FindUserRoles({ userId: "u1" });

      assert.deepStrictEqual(result, { roles: ["admin:u1"] });
    }).pipe(Effect.provide(handlers), Effect.scoped),
  );

  it.effect("carries only the tags it was given", () =>
    Effect.gen(function* () {
      const published = Query.subsetOf(group, "FindUserRoles");
      const dispatch = yield* Query.dispatcher(published);

      assert.deepStrictEqual(published.tags, ["FindUserRoles"]);
      assert.deepStrictEqual(Object.keys(dispatch), ["FindUserRoles"]);
    }).pipe(Effect.provide(handlers), Effect.scoped),
  );

  it("refuses a tag the group does not carry", () => {
    assert.throws(
      // @ts-expect-error "Nope" is not a tag of this group
      () => Query.subsetOf(group, "Nope"),
      /does not carry Nope/,
    );
  });

  it("keeps the side of the group it narrows", () => {
    assert.strictEqual(Query.subsetOf(group, "FindAllUsers").side, "query");
    assert.isTrue(Query.isGroup(Query.subsetOf(group, "FindAllUsers")));
  });
});
