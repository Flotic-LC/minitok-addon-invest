"use strict";

const { createAgentTools } = require("./tools");
const { createSafety } = require("./safety");
const { createTargetEngine, createEquitySnapshotter, resetTargetEngineState, TARGET_PHASES, DEFAULT_STATE_PATH } = require("./target");

const { createGoalBridge } = require("./goal-bridge");
const { createMcpBridge } = require("./mcp-bridge");
const { createAttributionEngine } = require("../intelligence/attribution");

module.exports = {
  createAgentTools,
  createSafety,
  createTargetEngine,
  createEquitySnapshotter,
  resetTargetEngineState,
  TARGET_PHASES,
  DEFAULT_STATE_PATH,
  createGoalBridge,
  createMcpBridge,
  createAttributionEngine,
};
