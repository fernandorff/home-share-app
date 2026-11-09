// App Router folders -> react-router tree for the Vite build (spec 013, 4.1): route groups "(x)" add no URL
// segment and every layout.tsx wraps its subtree. One bundle, no lazy routes: the pilot measured lazy route
// chunks 0.9–1.1 s slower to the visible list (chunk waterfall).
import type { ComponentType, ReactNode } from "react";
import { Navigate, Outlet, type RouteObject } from "react-router";
import NotFound from "../app/not-found";

const pages = import.meta.glob<{ default: ComponentType }>(["../app/**/page.tsx", "!../app/page.tsx"], { eager: true });
const layouts = import.meta.glob<{ default: ComponentType<{ children: ReactNode }> }>(
  ["../app/**/layout.tsx", "!../app/layout.tsx"],
  { eager: true }
);

const dirOf = (file: string) => file.replace(/^\.\.\/app/, "").replace(/\/(page|layout)\.tsx$/, "");
const urlOf = (dir: string) => dir.split("/").filter((s) => s && !/^\(.*\)$/.test(s)).join("/");

type Node = RouteObject & { dir: string; children: RouteObject[] };
const layoutNodes: Node[] = Object.entries(layouts)
  .map(([file, { default: Layout }]) => ({
    dir: dirOf(file),
    element: (
      <Layout>
        <Outlet />
      </Layout>
    ),
    children: [] as RouteObject[],
  }))
  .sort((a, b) => b.dir.length - a.dir.length);

const parentOf = (dir: string, self?: Node) => layoutNodes.find((l) => l !== self && (dir + "/").startsWith(l.dir + "/"));
const top: RouteObject[] = [];
for (const [file, { default: Page }] of Object.entries(pages)) {
  const dir = dirOf(file);
  (parentOf(dir)?.children ?? top).push({ path: "/" + urlOf(dir), element: <Page /> });
}
for (const l of layoutNodes) (parentOf(l.dir, l)?.children ?? top).push(l);
// src/app/page.tsx redirects on the server; a client-side push to "/" (after login) never reaches Axum.
top.push({ path: "/", element: <Navigate to="/expenses" replace /> });
top.push({ path: "*", element: <NotFound /> });

export const routes: RouteObject[] = top;
