import fs from "node:fs";
import path from "node:path";
import type { FetchFn } from "../src/lib/fetcher";

export const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures", name));

type Route = { status?: number; body?: string | Buffer; contentType?: string } | (() => Promise<Response>);

/** A fake fetch serving fixed routes by exact URL; unknown URLs 404. Records every call. */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fn: FetchFn = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (typeof route === "function") return route();
    if (!route) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    const body = typeof route.body === "string" ? route.body : route.body ? new Uint8Array(route.body) : "";
    return new Response(body, {
      status: route.status ?? 200,
      headers: { "content-type": route.contentType ?? "text/html; charset=utf-8" },
    });
  };
  return { fn, calls };
}

export const ARXIV_ID = "2401.00001";
export const arxivRoutes = {
  html: `https://arxiv.org/html/${ARXIV_ID}`,
  pdf: `https://arxiv.org/pdf/${ARXIV_ID}`,
  abs: `https://arxiv.org/abs/${ARXIV_ID}`,
};
