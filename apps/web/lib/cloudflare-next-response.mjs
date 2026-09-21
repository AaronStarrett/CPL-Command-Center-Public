// Worker-only facade over the pinned Next implementation. Avoid evaluating the
// CommonJS next/server barrel's unrelated ImageResponse/after/connection imports.
export { NextResponse } from "next/dist/server/web/spec-extension/response.js";
