// Next 16 renamed the middleware convention to `proxy`, and a proxy runs on the
// Node.js runtime, which is not configurable. That is the reason this file is
// named this way rather than habit: the guard resolves a database session
// through @/db, whose Neon pool needs a WebSocket that the edge runtime does
// not provide. As `middleware` it therefore crashed on every matched request
// once the control plane was hosted, while pages kept working.
export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!api/auth|signin|_next/static|_next/image|favicon.ico).*)"],
};
