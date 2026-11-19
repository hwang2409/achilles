export type SurfaceGroup = "work" | "library" | "manage";

type Entry = {
  id: string;
  label: string;
  group?: SurfaceGroup;
  capability: "agent" | "read" | "manage";
  icon: string;
  children?: true;
};

// Order here is the order in both navigation and the palette.
export const surfaceRoutes = ([
  { id: "chats", label: "chats", group: "work", capability: "agent", icon: "M3 3h10v8H7l-3 2v-2H3z" },
  { id: "pages", label: "pages", group: "work", capability: "agent", icon: "M4 2h5l3 3v9H4z M9 2v4h3" },
  { id: "agents", label: "agents", group: "work", capability: "read", icon: "M6 2h4v4H6z M2 10h4v4H2z M10 10h4v4h-4z M8 6v2 M4 10V8h8v2" },
  { id: "sessions", label: "sessions", group: "work", capability: "read", icon: "M3 4h10 M3 8h10 M3 12h7" },
  { id: "projects", label: "projects", group: "work", capability: "read", icon: "M2 4h5l2 2h5v7H2z" },
  { id: "telemetry", label: "telemetry", group: "work", capability: "read", icon: "M1 8h3l2-4 3 8 2-4h4", children: true },
  { id: "skills", label: "skills", group: "library", capability: "read", icon: "M3 3h10v10H3z M6 3v10" },
  { id: "agent-profiles", label: "agent profiles", group: "library", capability: "read", icon: "M10 5a2 2 0 1 1-4 0 2 2 0 1 1 4 0z M3 13a5 5 0 0 1 10 0" },
  { id: "settings", label: "settings", group: "manage", capability: "manage", icon: "M2 5h12 M2 11h12 M6 3v4 M10 9v4" },
  { id: "accounts", label: "accounts", group: "manage", capability: "manage", icon: "M2 4h12v8H2z M4 7h3 M4 9h6" },
  { id: "mcp", label: "mcp connections", group: "manage", capability: "manage", icon: "M5 2v3 M11 2v3 M4 5h8v3a4 4 0 0 1-8 0z M8 12v2" },
  { id: "create", label: "create", capability: "agent", icon: "m8 2 6 6-6 6-6-6z" },
] satisfies Entry[]).map((entry, order) => {
  const path = `/${entry.id}`;
  return { ...entry, path, order, match: (pathname: string) => pathname === path || (entry.children === true && pathname.startsWith(`${path}/`)) };
});

export type SurfaceRoute = (typeof surfaceRoutes)[number];
export const matchSurfaceRoute = (pathname: string) => surfaceRoutes.find((route) => route.match(pathname));
export const chatsRoute = surfaceRoutes[0];
export const createRoute = surfaceRoutes.find((route) => route.id === "create")!;

export const surfaceHref = (path: string) => {
  const url = new URL(path, location.href);
  url.search = location.search;
  url.searchParams.delete("chat");
  return `${url.pathname}${url.search}`;
};
