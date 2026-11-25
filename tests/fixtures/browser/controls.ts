import "../../../src/ui/labkit.css";
import { createLab, type LabDefinition } from "../../../src/index.ts";

interface DemoState {
  level: number;
  enabled: boolean;
  mode: string;
  pingCount: number;
  density: number;
  solo: boolean;
  soloAllowed: boolean;
  soloVisible: boolean;
  monitor: string;
  monitorAllowed: boolean;
  monitorVisible: boolean;
  phase: string;
  classShown: boolean;
  gridValue: number;
  gridSibling: number;
  flexValue: number;
  flexSibling: number;
}

const definition: LabDefinition<DemoState> = {
  contractVersion: "0.1",
  id: "sdk-controls-fixture",
  title: "Контролы: number / boolean / enum",
  model: {
    createState: () => ({
      level: 5,
      enabled: false,
      mode: "a",
      pingCount: 0,
      density: 4,
      solo: false,
      soloAllowed: true,
      soloVisible: true,
      monitor: "l",
      monitorAllowed: true,
      monitorVisible: true,
      phase: "p1",
      classShown: true,
      gridValue: 3,
      gridSibling: 4,
      flexValue: 5,
      flexSibling: 6,
    }),
  },
  parameters: {
    level: {
      kind: "number",
      id: "level",
      label: "Уровень",
      min: 0,
      max: 10,
      step: 1,
      read: (state) => state.level,
      write: (state, value) => {
        state.level = value;
      },
    },
    enabled: {
      kind: "boolean",
      id: "enabled",
      label: "Разрешить действие",
      read: (state) => state.enabled,
      write: (state, value) => {
        state.enabled = value;
      },
    },
    mode: {
      kind: "enum",
      id: "mode",
      label: "Режим",
      options: [
        { value: "a", label: "Режим A" },
        { value: "b", label: "Режим B" },
      ],
      read: (state) => state.mode,
      write: (state, value) => {
        state.mode = value;
      },
    },
    density: {
      kind: "number",
      id: "density",
      label: "Плотность",
      min: 0,
      max: 10,
      step: 1,
      read: (state) => state.density,
      write: (state, value) => {
        state.density = value;
      },
    },
    solo: {
      kind: "boolean",
      id: "solo",
      label: "Соло",
      available: (state) => state.soloAllowed,
      visible: (state) => state.soloVisible,
      read: (state) => state.solo,
      write: (state, value) => {
        state.solo = value;
      },
    },
    soloAllowed: {
      kind: "boolean",
      id: "soloAllowed",
      label: "Разрешить соло",
      read: (state) => state.soloAllowed,
      write: (state, value) => {
        state.soloAllowed = value;
      },
    },
    soloVisible: {
      kind: "boolean",
      id: "soloVisible",
      label: "Показывать соло",
      read: (state) => state.soloVisible,
      write: (state, value) => {
        state.soloVisible = value;
      },
    },
    monitor: {
      kind: "enum",
      id: "monitor",
      label: "Монитор",
      options: [
        { value: "l", label: "L" },
        { value: "m", label: "M" },
        { value: "h", label: "H" },
      ],
      available: (state) => state.monitorAllowed,
      visible: (state) => state.monitorVisible,
      read: (state) => state.monitor,
      write: (state, value) => {
        state.monitor = value;
      },
    },
    monitorAllowed: {
      kind: "boolean",
      id: "monitorAllowed",
      label: "Разрешить монитор",
      read: (state) => state.monitorAllowed,
      write: (state, value) => {
        state.monitorAllowed = value;
      },
    },
    monitorVisible: {
      kind: "boolean",
      id: "monitorVisible",
      label: "Показывать монитор",
      read: (state) => state.monitorVisible,
      write: (state, value) => {
        state.monitorVisible = value;
      },
    },
    phase: {
      kind: "enum",
      id: "phase",
      label: "Фаза",
      options: [
        { value: "p1", label: "Фаза 1" },
        { value: "p2", label: "Фаза 2" },
      ],
      read: (state) => state.phase,
      write: (state, value) => {
        state.phase = value;
      },
    },
    classShown: {
      kind: "boolean",
      id: "classShown",
      label: "Показывать классовые",
      read: (state) => state.classShown,
      write: (state, value) => {
        state.classShown = value;
      },
    },
    gridValue: {
      kind: "number",
      id: "gridValue",
      label: "Grid value",
      min: 0,
      max: 10,
      step: 1,
      visible: (state) => state.classShown,
      read: (state) => state.gridValue,
      write: (state, value) => {
        state.gridValue = value;
      },
    },
    gridSibling: {
      kind: "number",
      id: "gridSibling",
      label: "Grid sibling",
      min: 0,
      max: 10,
      step: 1,
      read: (state) => state.gridSibling,
      write: (state, value) => {
        state.gridSibling = value;
      },
    },
    flexValue: {
      kind: "number",
      id: "flexValue",
      label: "Flex value",
      min: 0,
      max: 10,
      step: 1,
      visible: (state) => state.classShown,
      read: (state) => state.flexValue,
      write: (state, value) => {
        state.flexValue = value;
      },
    },
    flexSibling: {
      kind: "number",
      id: "flexSibling",
      label: "Flex sibling",
      min: 0,
      max: 10,
      step: 1,
      read: (state) => state.flexSibling,
      write: (state, value) => {
        state.flexSibling = value;
      },
    },
  },
  actions: {
    ping: {
      id: "ping",
      label: "Ping",
      available: (state) => state.enabled,
      run: (ctx) => {
        ctx.state.pingCount += 1;
        ctx.requestRender();
      },
    },
  },
  readouts: {
    summary: (state) =>
      `level=${state.level} · enabled=${state.enabled} · mode=${state.mode}` +
      ` · solo=${state.solo} · monitor=${state.monitor} · Ping: ${state.pingCount}`,
  },
  hooks: { onChange: (ctx) => ctx.requestRender() },
  layout: {
    controls: [
      { kind: "control", param: "level" },
      { kind: "control", param: "enabled" },
      { kind: "control", param: "mode" },
      { kind: "action", action: "ping" },
      {
        kind: "group",
        title: "Плотный ряд",
        children: [
          {
            kind: "row",
            columns: 3,
            density: "compact",
            children: [
              { kind: "control", param: "density" },
              { kind: "control", param: "solo", presentation: "pad", displayLabel: "S" },
              { kind: "control", param: "monitor", presentation: "segmented", displayLabel: "M" },
            ],
          },
        ],
      },
      {
        kind: "group",
        title: "Управление видимостью",
        children: [
          {
            kind: "row",
            columns: 2,
            density: "compact",
            children: [
              { kind: "control", param: "soloAllowed" },
              { kind: "control", param: "soloVisible" },
              { kind: "control", param: "monitorAllowed" },
              { kind: "control", param: "monitorVisible" },
            ],
          },
        ],
      },
      {
        kind: "group",
        title: "Поле в ряду",
        children: [
          {
            kind: "row",
            columns: 2,
            density: "compact",
            children: [
              { kind: "control", param: "phase" },
              { kind: "note", text: "Соседнее поле" },
            ],
          },
        ],
      },
      {
        kind: "group",
        title: "ClassName layout",
        children: [
          { kind: "control", param: "classShown" },
          {
            kind: "row",
            columns: 2,
            density: "compact",
            children: [
              { kind: "control", param: "gridValue", className: "classed-grid-cell" },
              { kind: "control", param: "gridSibling", className: "classed-grid-sibling" },
            ],
          },
          {
            kind: "row",
            className: "classed-flex-host",
            density: "compact",
            children: [
              { kind: "control", param: "flexValue", className: "classed-flex-cell" },
              { kind: "control", param: "flexSibling", className: "classed-flex-sibling" },
            ],
          },
        ],
      },
    ],
    workspace: [{ kind: "readout", id: "summary", variant: "stat" }],
  },
};

const host = document.getElementById("app");
if (!host) throw new Error("controls fixture: #app is missing");
const instance = createLab(definition, host);
declare global {
  interface Window {
    __controlsFixture: { instance: typeof instance };
  }
}

window.__controlsFixture = { instance };
