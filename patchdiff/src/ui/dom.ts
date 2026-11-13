// Tiny hash router and shared DOM helpers. No framework dependency.
export type Route = 'library' | 'disasm' | 'cfg' | 'diff' | 'scan';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(child));
  return node;
}

export function toast(message: string, isError = false): void {
  const t = document.getElementById('toast')!;
  t.textContent = message;
  t.classList.toggle('error', isError);
  t.classList.remove('hidden');
  window.setTimeout(() => t.classList.add('hidden'), 3200);
}

export function hex(n: number, width = 0): string {
  return '0x' + n.toString(16).padStart(width, '0');
}

const ROUTES: Route[] = ['library', 'disasm', 'cfg', 'diff', 'scan'];

export function currentRoute(): Route {
  const hash = window.location.hash.replace('#/', '') as Route;
  return ROUTES.includes(hash) ? hash : 'library';
}

export function navigate(route: Route): void {
  window.location.hash = `#/${route}`;
}

export function onRouteChange(fn: (r: Route) => void): void {
  window.addEventListener('hashchange', () => fn(currentRoute()));
}

export function setActiveNav(route: Route): void {
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', (a as HTMLElement).dataset.route === route);
  });
}

export function readFileBytes(file: File): Promise<Uint8Array> {
  return file.arrayBuffer().then((buf) => new Uint8Array(buf));
}
