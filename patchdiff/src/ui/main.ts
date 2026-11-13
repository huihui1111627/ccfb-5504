// Application entry: hash-based router that mounts one page at a time.
import { currentRoute, onRouteChange, setActiveNav, type Route } from './dom';
import { renderLibrary } from './pages/library';
import { renderDisasm } from './pages/disasm';
import { renderCfg } from './pages/cfg';
import { renderDiff } from './pages/diff';
import { renderScan } from './pages/scan';

const view = document.getElementById('view')!;

function mount(route: Route): void {
  setActiveNav(route);
  switch (route) {
    case 'library': return renderLibrary(view);
    case 'disasm': return renderDisasm(view);
    case 'cfg': return renderCfg(view);
    case 'diff': return renderDiff(view);
    case 'scan': return renderScan(view);
  }
}

mount(currentRoute());
onRouteChange(mount);
