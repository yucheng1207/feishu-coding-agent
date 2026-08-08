import type { AppConfig, EngineName } from "../config.js"
import { createCursorEngine } from "./cursor.js"
import { createKiroEngine } from "./kiro.js"
import type { CodingEngine } from "./types.js"

export type { CodingEngine, PromptResult } from "./types.js"

export function createEngines(cfg: AppConfig): Record<EngineName, CodingEngine> {
  return {
    cursor: createCursorEngine(cfg),
    kiro: createKiroEngine(cfg),
  }
}
