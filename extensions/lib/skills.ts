/**
 * What this package ships, and where it lives.
 *
 * The list is short on purpose, and the reason is the layout of the whole thing:
 *
 *   - The upstream **planning** skills are not shipped here. `/fleet-setup`
 *     installs the upstream repository into the project behind a settings filter,
 *     so those skills track upstream instead of a pinned copy.
 *   - The upstream **execution** skills are not shipped here either. Codex and
 *     Claude install them on their own machines, and this package names them in
 *     the task text instead of handing over a path. Shipping a second copy made
 *     the executor load two revisions of one skill at once.
 *   - Only `skills/fleet` — this package's own orchestration loop — ships as a
 *     skill, and it is the only one the package manifest declares.
 *
 * So there is nothing here to resolve, validate, or hand out. What remains is the
 * one path the `/fleet-setup` command needs: its own.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** The package root: `extensions/lib/` sits two levels below it. */
export const PACKAGE_ROOT = dirname(dirname(here));
/** The setup script. Its own path, so the command never guesses one. */
export const INSTALL_SCRIPT = join(PACKAGE_ROOT, "scripts", "install-planning.mjs");
