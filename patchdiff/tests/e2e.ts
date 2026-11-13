// End-to-end browser test using Playwright against the Vite dev server.
// Verifies the full UI -> Web Worker -> analysis engine pipeline:
// import, disassembly, CFG, diff (incl. stripped) and YARA scanning.
import { chromium, type Browser, type Page } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sample = (name: string) => join(root, 'samples/bin', name);

const assert = (cond: boolean, msg: string) => { if (!cond) { throw new Error('ASSERT FAIL: ' + msg); } };

async function serveVite(): Promise<{ url: string; stop: () => void }> {
  // Vite dev server exposes the app and serves the worker as an ES module.
  const mod = await import('vite');
  const server = await mod.createServer({ root, server: { port: 0 }, logLevel: 'silent' });
  await server.listen();
  const info = server.httpServer!.address() as { port: number };
  return { url: `http://localhost:${info.port}/`, stop: () => void server.close() };
}

async function importFile(page: Page, path: string, expectedRows: number): Promise<void> {
  await page.setInputFiles('input[type=file]', path);
  await page.waitForFunction((n) => document.querySelectorAll('tbody tr').length >= n, expectedRows);
  await page.waitForTimeout(150); // let the worker response and store settle
}

let browser: Browser;
let passed = 0;
const check = (name: string) => { passed++; console.log('  ✓', name); };

async function main(): Promise<void> {
  const { url, stop } = await serveVite();
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // Ensure corpus exists.
  if (!existsSync(sample('fw.clang.x86_64.O0.rel.unstripped.o'))) {
    execFileSync('bash', [join(root, 'scripts/build-samples.sh')], { cwd: root });
  }

  await page.goto(url);
  await page.waitForSelector('.dropzone');
  check('app shell renders');

  // 1. Import two binaries (original + patched), one stripped to prove recovery.
  await importFile(page, sample('fw.clang.x86_64.O0.rel.unstripped.o'), 1);
  await importFile(page, sample('fw_patched.clang.x86_64.O0.rel.stripped.o'), 2);
  const count = await page.textContent('#binary-count');
  assert(count === '2 binaries', `expected 2 binaries, got ${count}`);
  check('two binaries imported via worker pipeline');

  // Library table shows parsed functions.
  const fnCells = await page.$$eval('tbody tr', (rows) => rows.length);
  assert(fnCells >= 2, `library lists binaries, got ${fnCells} rows`);
  check('library shows parsed metadata');

  // 2. Disassembly page.
  await page.click('[data-route="disasm"]');
  await page.waitForSelector('.disasm .inst');
  const instCount = await page.$$eval('.disasm .inst', (n) => n.length);
  assert(instCount > 50, `expected many disassembled instructions, got ${instCount}`);
  const firstText = await page.textContent('.disasm .inst .mn');
  assert(!!firstText && firstText.length > 0, 'mnemonic rendered');
  check(`disassembly renders ${instCount} instructions`);

  // Function tab and rename.
  await page.click('button:has-text("Functions")');
  await page.waitForSelector('tbody tr.clickable');
  await page.click('tbody tr.clickable:first-child');
  await page.waitForSelector('.disasm');
  check('function navigation works');

  // 3. CFG page.
  await page.click('[data-route="cfg"]');
  await page.waitForSelector('.cfg-canvas svg');
  const nodes = await page.$$eval('.cfg-node', (n) => n.length);
  const edges = await page.$$eval('.cfg-edge', (n) => n.length);
  assert(nodes >= 1, `CFG has nodes, got ${nodes}`);
  check(`CFG renders ${nodes} blocks and ${edges} edges`);

  // 4. Diff page: run and confirm changed functions detected.
  await page.click('[data-route="diff"]');
  await page.waitForSelector('.card select');
  await page.click('button:has-text("Run diff")');
  await page.waitForSelector('.stat .num');
  const stats = await page.$$eval('.stat .num', (els) => els.map((e) => e.textContent));
  assert(stats.length === 3, `three stat cards, got ${stats.length}`);
  await page.waitForFunction(() => {
    const tags = [...document.querySelectorAll('.tag.modified')];
    return tags.length > 0;
  });
  check(`diff produced stats ${JSON.stringify(stats)} with modified functions`);

  // Expand a changed function into block-level view.
  await page.click('tbody tr.clickable');
  await page.waitForSelector('.diff-code .plus, .diff-code .minus');
  check('block-level add/remove rows render');

  // 5. Scanner page with built-in YARA rules.
  await page.click('[data-route="scan"]');
  await page.waitForSelector('textarea');
  await page.click('button:has-text("Scan binary")');
  await page.waitForSelector('.card h3');
  const hitHeading = await page.textContent('.card h3');
  assert(!!hitHeading && hitHeading.includes('Hits'), `hit heading present: ${hitHeading}`);
  check(`scanner ran: ${hitHeading}`);

  // No uncaught errors from the worker or UI.
  await page.waitForTimeout(300);
  const realErrors = errors.filter((e) => !e.includes('favicon'));
  assert(realErrors.length === 0, `unexpected console/page errors: ${realErrors.join(' | ')}`);
  check('no uncaught browser errors');

  await browser.close();
  stop();
  console.log(`\nE2E PASSED: ${passed} checks`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
