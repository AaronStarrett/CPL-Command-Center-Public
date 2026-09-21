let replaceRoute: (href: string) => void = () => undefined;
let pushRoute: (href: string) => void = () => undefined;
let refreshRoute: () => void = () => undefined;
let currentPathname = "/";

export function setTestRouterReplace(next: (href: string) => void) {
  replaceRoute = next;
}

export function setTestRouterPush(next: (href: string) => void) {
  pushRoute = next;
}

export function setTestRouterRefresh(next: () => void) {
  refreshRoute = next;
}

export function setTestPathname(next: string) {
  currentPathname = next;
}

export function usePathname() {
  return currentPathname;
}

export function useRouter() {
  return {
    push: (href: string) => pushRoute(href),
    refresh: () => refreshRoute(),
    replace: (href: string) => replaceRoute(href),
  };
}
