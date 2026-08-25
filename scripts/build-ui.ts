#!/usr/bin/env tsx
/**
 * Assemble the Command Center page.
 *
 * Inlines the engine bundle and the app layer into the template. The published
 * page must be entirely self-contained: the artifact CSP blocks every external
 * host except Google Fonts.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/config/load.js';

const OUT_DIR = join(REPO_ROOT, 'dist', 'ui');
mkdirSync(OUT_DIR, { recursive: true });

const template = readFileSync(join(REPO_ROOT, 'ui', 'command-center.template.html'), 'utf8');
const engine = readFileSync(join(REPO_ROOT, 'dist', 'browser', 'engine.js'), 'utf8');
const app = readFileSync(join(REPO_ROOT, 'ui', 'app.js'), 'utf8');

// The interpreted state document from the last sync, embedded so the page opens
// with real content rather than waiting on a connector round-trip.
const statePath = join(REPO_ROOT, 'dist', 'state.json');
const state = existsSync(statePath) ? readFileSync(statePath, 'utf8') : '{}';

/*
 * Viewer state — corrections and dismissals made IN the published page.
 *
 * The page saves new versions of itself, so a rebuild that ignored this would
 * silently discard the human's corrections. Those corrections are the most
 * valuable data the system has: they are how it learns it was wrong.
 */
const viewerPath = join(REPO_ROOT, 'dist', 'viewer-state.json');
const viewerState = existsSync(viewerPath) ? readFileSync(viewerPath, 'utf8') : '';

// A literal </script> inside an inlined script would close the tag early.
const safe = (s: string) => s.replace(/<\/script>/gi, '<\\/script>');

// Replacer FUNCTIONS, not strings. A string replacement interprets `$&`,
// backtick-$ and `$'` as substitution patterns, and the minified engine
// contains `\\$&` from its own regex-escaping code — passing it as a string
// splices the surrounding template back into the bundle and corrupts it.
const html = template
  .replace('/*__DATA__*/', () => safe(state))
  .replace('/*__VIEWER_STATE__*/', () => safe(viewerState))
  .replace('/*__ENGINE__*/', () => safe(engine))
  .replace('/*__APP__*/', () => safe(app));

const out = join(OUT_DIR, 'command-center.html');
writeFileSync(out, html, 'utf8');
console.log(`✓ ${out} — ${(html.length / 1024).toFixed(0)} KB`);
if (viewerState) {
  const parsed = JSON.parse(viewerState) as { corrections?: object; dismissed?: unknown[] };
  console.log(`  carried forward: ${Object.keys(parsed.corrections ?? {}).length} corrections, ${(parsed.dismissed ?? []).length} dismissed`);
}
