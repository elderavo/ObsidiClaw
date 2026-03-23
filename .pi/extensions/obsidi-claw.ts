/**
 * ObsidiClaw extension entry point for Pi's native TUI.
 *
 * Pi auto-discovers .pi/extensions/ in the project directory.
 * When the user runs `pi` here, this file is loaded and the factory
 * is registered — context injection happens transparently on every turn.
 *
 * The extension owns its own ContextEngine lifecycle (init on session_start,
 * close on session_shutdown). No external runner required.
 */

import { join } from "path";
import { fileURLToPath } from "url";
import { createObsidiClawExtension } from "../../entry/extension.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const rootDir = join(__dirname, "../..");

export default createObsidiClawExtension({ rootDir });
