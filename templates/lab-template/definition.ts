import {
  attachMidi,
  CONTRACT_VERSION,
  realMidiEnvironment,
  type LabDefinition,
  type MidiEnvironment,
  type MidiStorage,
} from "labkit";
import { createState, DEFAULT_LEVEL, type LabState } from "./state.ts";

export const LAB_ID = "lab-template";
export const LAB_TITLE = "Lab Template";

export interface LabOptions {
  midiEnvironment?: MidiEnvironment;
  midiStorage?: MidiStorage;
}

export function createDefinition(options: LabOptions = {}): LabDefinition<LabState> {
  return {
    contractVersion: CONTRACT_VERSION,
    id: LAB_ID,
    title: LAB_TITLE,
    model: { createState },
    capabilities: { optional: ["midi"] },
    parameters: {
      level: {
        kind: "number",
        id: "level",
        label: "Level",
        min: 0,
        max: 1,
        step: 0.01,
        read: (state) => state.level,
        write: (state, value) => {
          state.level = value;
        },
      },
    },
    actions: {
      reset: {
        id: "reset",
        label: "Reset",
        run: (ctx) => ctx.params.set("level", DEFAULT_LEVEL, ctx.origin),
      },
    },
    readouts: { level: (state) => state.level.toFixed(2) },
    hooks: {
      setup(ctx, lifetime) {
        attachMidi(ctx, lifetime, {
          namespace: LAB_ID,
          environment: options.midiEnvironment ?? realMidiEnvironment,
          storage: options.midiStorage,
        });
        return undefined;
      },
      onChange: (ctx) => ctx.requestRender(),
    },
    layout: {
      controls: [{ kind: "control", param: "level" }],
      workspace: [
        { kind: "readout", id: "level", label: "Level" },
        { kind: "action", action: "reset" },
      ],
    },
  };
}
