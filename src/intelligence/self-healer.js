"use strict";

/**
 * Self-Healer re-export shim — Phase R-6.
 *
 * The canonical self-healer implementation lives at:
 *   ./src/orchestrator/self-healing.js
 *
 * This shim re-exports it from the intelligence layer so that:
 *   - Uniform `./src/intelligence/*` imports work for all R-series modules
 *   - Future code searching for "intelligence/self-healer" finds the real module
 *   - The orchestrator path remains the authoritative source (no duplication)
 *
 * Usage (both paths are equivalent):
 *   const { createSelfHealer } = require("./src/intelligence/self-healer");
 *   const { createSelfHealer } = require("./src/orchestrator/self-healing");
 */

module.exports = require("../orchestrator/self-healing");
