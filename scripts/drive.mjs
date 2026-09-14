/**
 * drive — cross-platform launcher for the in-app harnesses.
 *   node scripts/drive.mjs e2e   → SHAPEDAY_E2E=1 (12-check end-to-end run)
 *   node scripts/drive.mjs shot  → SHAPEDAY_SHOT=1 (seed demo day → shots/)
 * Unsets ELECTRON_RUN_AS_NODE (some environments set it globally) and passes
 * --no-sandbox so it also runs as root under WSLg.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// the electron module's export IS the path to the binary
const electronPath = require('electron');
const flag = process.argv[2] === 'shot' ? 'SHAPEDAY_SHOT' : 'SHAPEDAY_E2E';

const env = { ...process.env, [flag]: '1' };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.', '--no-sandbox'], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 1));
