import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import {
  InformationPage,
  SiteFooter,
  informationPageContent,
  informationPageIds,
} from "../src/pages/InformationPages";

function renderRoute(path: string): string {
  const informationRoutes = informationPageIds.map((page) => createElement(Route, {
    key: page,
    path: `/${page}`,
    element: createElement(InformationPage, { page }),
  }));
  const tree = createElement(
    MemoryRouter,
    { initialEntries: [path] },
    createElement(Routes, null, ...informationRoutes),
  );
  return renderToStaticMarkup(tree);
}

test("all public information routes render their page heading and main content", () => {
  for (const page of informationPageIds) {
    const markup = renderRoute(`/${page}`);
    assert.match(markup, /<main class="information-page-wrap">/);
    assert.ok(markup.includes(`<h1 id="information-page-title">${informationPageContent[page].title}</h1>`));
  }
});

test("all footer placements link to every information page in the displayed order", () => {
  for (const placement of ["global", "sidebar", "menu"] as const) {
    const markup = renderToStaticMarkup(createElement(
      MemoryRouter,
      null,
      createElement(SiteFooter, { placement }),
    ));

    const hrefs = [...markup.matchAll(/<a[^>]+href="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(hrefs, informationPageIds.map((page) => `/${page}`));
    assert.match(markup, /aria-label="Site information"/);
    assert.match(markup, new RegExp(`site-footer-${placement}`));
  }
});

test("help and policy pages link account recovery, explain reports, and avoid unsupported privacy controls", () => {
  const help = renderRoute("/help");
  const terms = renderRoute("/terms");

  assert.match(help, /href="\/forgot-password"/);
  assert.match(help, /href="\/reports"/);
  assert.match(help, /owner receives a notification/);
  assert.match(help, /reporter(?:'|&#x27;)s identity is not shared/);
  assert.match(help, /Reports expire after seven days/);
  assert.doesNotMatch(help, /does not currently provide an in-app report form/);
  assert.match(terms, /href="\/community-guidelines"/);
  const privacy = renderRoute("/privacy");
  assert.match(privacy, /short text excerpt/);
  assert.match(privacy, /jannino\.dev@gmail\.com/);
  assert.doesNotMatch(privacy, /Ad Choices|Cookie Settings/);
});
