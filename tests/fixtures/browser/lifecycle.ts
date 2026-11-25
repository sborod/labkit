import "../../../src/ui/labkit.css";
import {
  CONTRACT_VERSION,
  createLab,
  type LabDefinition,
  type LabServices,
} from "../../../src/index.ts";

interface LifecycleState {
  value: number;
}

const definition: LabDefinition<LifecycleState> = {
  contractVersion: CONTRACT_VERSION,
  id: "sdk-lifecycle-fixture",
  title: "SDK lifecycle fixture",
  capabilities: { required: ["canvas"] },
  model: { createState: () => ({ value: 1.2 }) },
  parameters: {
    value: {
      kind: "number",
      id: "value",
      label: "Value",
      min: 0,
      max: 10,
      step: 0.1,
      read: (state) => state.value,
      write: (state, value) => {
        state.value = value;
      },
    },
  },
  views: {
    surface: {
      render: ({ ctx, width, height }) => {
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = "#3762d8";
        ctx.fillRect(0, 0, width, height);
      },
    },
  },
  layout: {
    controls: [{ kind: "control", param: "value" }],
    workspace: [{ kind: "panel", view: "surface" }],
  },
};

function mount(host: HTMLElement, services?: LabServices) {
  return createLab(definition, host, services);
}

const app = document.getElementById("app");
if (!app) throw new Error("SDK lifecycle fixture: #app is missing");
const instance = mount(app);
declare global {
  interface Window {
    __lifecycleFixture: { instance: typeof instance; mount: typeof mount };
  }
}

window.__lifecycleFixture = { instance, mount };
