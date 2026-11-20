// @ts-expect-error Bun supplies this module at test time; the web project does not install Bun types.
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PagesLanding } from "./PagesLanding";

test("omits the changed fact for an invalid page date", () => {
  const page = { id: "sample", route: "/sample", title: "sample", created_at: "2025-01-01", create_mode: false, chat_count: 0, created_by_route: null };
  const markup = renderToStaticMarkup(<PagesLanding catalog={{ items: [
    { ...page, updated_at: "2025-01-45" },
    { ...page, id: "valid", route: "/valid", updated_at: "2025-01-01" },
  ], next: null, loading: false, error: false, meta: null }} reload={() => {}} more={async () => {}} />);

  expect(markup).not.toMatch(/invalid date/i);
  expect(markup.match(/changed <time/g)).toHaveLength(1);
});
