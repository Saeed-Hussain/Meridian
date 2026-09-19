/**
 * Start the application.
 *
 * This exists for one reason. `ELECTRON_RUN_AS_NODE` tells the Electron binary
 * to behave as a plain Node interpreter — no windows, no `app`, none of it —
 * and editors built on Electron, VS Code among them, set it in the environment
 * of every terminal they open.
 *
 * So running `electron .` from inside such an editor silently starts a Node
 * process instead of an application, and the first thing the code touches is
 * undefined. The error says nothing about the cause, which cost an afternoon
 * once and is the sort of thing worth a file of its own.
 *
 * Launching through here removes the variable and starts Electron properly,
 * wherever the terminal came from.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// The --probe flag starts the self-check instead of the application.
const probing = process.argv.includes('--probe');
const entry = probing ? path.join(__dirname, 'probe.cjs') : path.join(__dirname, '..');

const child = spawn(String(electron), [entry, ...process.argv.slice(2).filter((a) => a !== '--probe')], {
  stdio: 'inherit',
  env,
});

child.on('close', (code) => process.exit(code ?? 0));
