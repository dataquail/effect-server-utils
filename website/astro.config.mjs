import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  integrations: [
    starlight({
      title: "Effect Server Utils",
      description:
        "Server-side building blocks for Effect: typed CQRS buses, a unit-of-work boundary, and declarative per-route authorization.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/dataquail/effect-server-utils",
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { slug: "getting-started/introduction" },
            { slug: "getting-started/installation" },
          ],
        },
        {
          label: "CQRS",
          items: [
            { slug: "cqrs", label: "Overview" },
            { slug: "cqrs/commands" },
            { slug: "cqrs/queries" },
            { slug: "cqrs/dispatch-tables" },
            { slug: "cqrs/events" },
            { slug: "cqrs/sagas" },
            { slug: "cqrs/middleware" },
            { slug: "cqrs/unhandled-failures" },
            { slug: "cqrs/testing" },
          ],
        },
        {
          label: "Unit of Work",
          items: [{ slug: "unit-of-work", label: "Overview" }],
        },
        {
          label: "AuthZ",
          items: [
            { slug: "authz", label: "Overview" },
            { slug: "authz/configuration" },
            { slug: "authz/checks" },
            { slug: "authz/policies" },
            { slug: "authz/resources" },
            { slug: "authz/adapter" },
          ],
        },
      ],
    }),
  ],
  site: "https://dataquail.github.io",
  base: "/effect-server-utils",
});
