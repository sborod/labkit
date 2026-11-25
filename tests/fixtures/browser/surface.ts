import { DisplaySurface } from "../../../src/runtime/surface.ts";

const host = document.getElementById("panel");
if (!host) throw new Error("surface fixture: #panel is missing");
const draw = (): void => {
  surface.clear();
  surface.ctx.fillStyle = "#3762d8";
  surface.ctx.fillRect(0, 0, surface.cssWidth, surface.cssHeight);
};
const surface = new DisplaySurface(document, { onInvalidate: draw });
surface.attach(host);
Object.assign(window, { __surfaceFixture: { surface } });
