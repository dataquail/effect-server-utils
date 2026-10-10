import { deepStrictEqual, ok } from "node:assert";

import { describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as Event from "./event.js";
import {
  DuplicateSubscriptionName,
  EventBus,
  makeEventBus,
  UndeliverableEnvelope,
  UnnamedAfterCommitSubscription,
} from "./event-bus.js";
import { type UnhandledFailure, UnhandledFailures } from "./unhandled-failures.js";

const Scheduled = Event.make("Scheduled", { id: Schema.String, at: Schema.DateTimeUtcFromMillis });
const Unwatched = Event.make("Unwatched", { id: Schema.String });

const at = (millis: number) => Schema.decodeSync(Schema.DateTimeUtcFromMillis)(millis);

const recordingFailures = Effect.gen(function* () {
  const reported = yield* Ref.make<ReadonlyArray<UnhandledFailure>>([]);
  return {
    reported: Ref.get(reported),
    layer: Layer.succeed(
      UnhandledFailures,
      UnhandledFailures.of({
        report: (failure) => Ref.update(reported, (prev) => [...prev, failure]),
        stream: Effect.die("unused"),
      }),
    ),
  };
});

const defectOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Result.getOrUndefined(Cause.findDefect(exit.cause)) : undefined;

/** The one envelope a single-subscription dispatch seals. */
const only = <A, E, R>(envelopes: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  Effect.flatMap(envelopes, ([envelope, ...rest]) =>
    envelope !== undefined && rest.length === 0
      ? Effect.succeed(envelope)
      : Effect.die(
          `expected exactly one envelope, got ${rest.length + (envelope === undefined ? 0 : 1)}`,
        ),
  );

describe("EventBus.subscribeAfterCommit naming", () => {
  it.effect("refuses a second subscription to one event under the same name", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      yield* bus.subscribeAfterCommit(Scheduled, () => Effect.void, { name: "notify" });

      const second = yield* Effect.exit(
        bus.subscribeAfterCommit(Scheduled, () => Effect.void, { name: "notify" }),
      );

      ok(defectOf(second) instanceof DuplicateSubscriptionName);
    }).pipe(Effect.provide(makeEventBus())),
  );

  it.effect("lets two events share a subscription name", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      yield* bus.subscribeAfterCommit(Scheduled, () => Effect.void, { name: "notify" });
      yield* bus.subscribeAfterCommit(Unwatched, () => Effect.void, { name: "notify" });
    }).pipe(Effect.provide(makeEventBus())),
  );

  it.effect("reports an in-process failure under the subscription's name", () =>
    Effect.gen(function* () {
      const failures = yield* recordingFailures;
      yield* Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.subscribeAfterCommit(Scheduled, () => Effect.die("boom"), { name: "notify" });
        yield* bus.dispatch([Scheduled.make({ id: "a", at: at(0) })]);
      }).pipe(Effect.provide(Layer.merge(makeEventBus(), failures.layer)));

      deepStrictEqual(
        (yield* failures.reported).map((failure) => failure.source),
        ["notify"],
      );
    }),
  );
});

describe("EventBus.envelop", () => {
  it.effect("seals one envelope per subscription, sharing the event's id", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      yield* bus.subscribeAfterCommit(Scheduled, () => Effect.void, { name: "first" });
      yield* bus.subscribeAfterCommit(Scheduled, () => Effect.void, { name: "second" });

      const envelopes = yield* bus.envelop([Scheduled.make({ id: "a", at: at(1_000) })]);

      deepStrictEqual(
        envelopes.map(({ handler, payload, tag }) => ({ tag, handler, payload })),
        [
          {
            tag: "Scheduled",
            handler: "first",
            payload: { _tag: "Scheduled", id: "a", at: 1_000 },
          },
          {
            tag: "Scheduled",
            handler: "second",
            payload: { _tag: "Scheduled", id: "a", at: 1_000 },
          },
        ],
      );
      const [first, second] = envelopes;
      deepStrictEqual(first?.eventId, second?.eventId);
      ok(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
          first?.eventId ?? "",
        ),
      );
    }).pipe(Effect.provide(makeEventBus())),
  );

  it.effect("gives each event its own id", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      yield* bus.subscribeAfterCommit(Scheduled, () => Effect.void, { name: "notify" });

      const envelopes = yield* bus.envelop([
        Scheduled.make({ id: "a", at: at(0) }),
        Scheduled.make({ id: "b", at: at(0) }),
      ]);

      deepStrictEqual(new Set(envelopes.map((envelope) => envelope.eventId)).size, 2);
    }).pipe(Effect.provide(makeEventBus())),
  );

  it.effect("seals nothing for an event no after-commit subscription answers", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      yield* bus.subscribe(Unwatched, () => Effect.void);

      deepStrictEqual(yield* bus.envelop([Unwatched.make({ id: "a" })]), []);
    }).pipe(Effect.provide(makeEventBus())),
  );

  it.effect("refuses to seal for an unnamed subscription", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      yield* bus.subscribeAfterCommit(Scheduled, () => Effect.void);

      const exit = yield* Effect.exit(bus.envelop([Scheduled.make({ id: "a", at: at(0) })]));

      ok(defectOf(exit) instanceof UnnamedAfterCommitSubscription);
    }).pipe(Effect.provide(makeEventBus())),
  );
});

describe("EventBus.deliver", () => {
  it.effect("runs only the addressed subscription, with the decoded event", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      const received = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* bus.subscribeAfterCommit(
        Scheduled,
        (event) => Ref.update(received, (prev) => [...prev, `first:${event.at.epochMilliseconds}`]),
        { name: "first" },
      );
      yield* bus.subscribeAfterCommit(
        Scheduled,
        () => Ref.update(received, (prev) => [...prev, "second"]),
        { name: "second" },
      );
      const first = yield* only(
        Effect.map(bus.envelop([Scheduled.make({ id: "a", at: at(1_000) })]), (envelopes) =>
          envelopes.filter((envelope) => envelope.handler === "first"),
        ),
      );

      const exit = yield* bus.deliver(first);

      ok(Exit.isSuccess(exit));
      deepStrictEqual(yield* Ref.get(received), ["first:1000"]);
    }).pipe(Effect.provide(makeEventBus())),
  );

  it.effect("runs the reaction inside the boundary it is given, returning its value", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      yield* bus.subscribeAfterCommit(Scheduled, () => Effect.void, { name: "notify" });
      const envelope = yield* only(bus.envelop([Scheduled.make({ id: "a", at: at(0) })]));

      const exit = yield* bus.deliver(envelope, (reaction) => Effect.as(reaction, "bounded"));

      deepStrictEqual(exit, Exit.succeed("bounded"));
    }).pipe(Effect.provide(makeEventBus())),
  );

  it.effect("fails an envelope no subscription answers as undeliverable", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      yield* bus.subscribeAfterCommit(Scheduled, () => Effect.void, { name: "notify" });
      const envelope = yield* only(bus.envelop([Scheduled.make({ id: "a", at: at(0) })]));

      const exit = yield* bus.deliver({ ...envelope, handler: "renamed" });

      ok(Exit.isFailure(exit));
      const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
      ok(error instanceof UndeliverableEnvelope);
      deepStrictEqual(error.reason, "unknown-subscription");
    }).pipe(Effect.provide(makeEventBus())),
  );

  it.effect("fails a payload its event's schema no longer decodes as undeliverable", () =>
    Effect.gen(function* () {
      const bus = yield* EventBus;
      yield* bus.subscribeAfterCommit(Scheduled, () => Effect.void, { name: "notify" });
      const envelope = yield* only(bus.envelop([Scheduled.make({ id: "a", at: at(0) })]));

      const exit = yield* bus.deliver({ ...envelope, payload: { _tag: "Scheduled", id: 1 } });

      ok(Exit.isFailure(exit));
      const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
      ok(error instanceof UndeliverableEnvelope);
      deepStrictEqual(error.reason, "undecodable-payload");
    }).pipe(Effect.provide(makeEventBus())),
  );

  it.effect("returns a failing handler's exit and reports it under its name", () =>
    Effect.gen(function* () {
      const failures = yield* recordingFailures;
      const exit = yield* Effect.gen(function* () {
        const bus = yield* EventBus;
        yield* bus.subscribeAfterCommit(Scheduled, () => Effect.die("boom"), { name: "notify" });
        const envelope = yield* only(bus.envelop([Scheduled.make({ id: "a", at: at(0) })]));
        return yield* bus.deliver(envelope);
      }).pipe(Effect.provide(Layer.merge(makeEventBus(), failures.layer)));

      deepStrictEqual(defectOf(exit), "boom");
      deepStrictEqual(
        (yield* failures.reported).map(({ eventTag, kind, source }) => ({
          source,
          kind,
          eventTag,
        })),
        [{ source: "notify", kind: "after-commit-handler", eventTag: "Scheduled" }],
      );
    }),
  );
});
