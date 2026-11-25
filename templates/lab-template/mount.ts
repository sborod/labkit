import { createLab, type LabServices } from "labkit";
import { createDefinition, type LabOptions } from "./definition.ts";

export function mountLab(container: HTMLElement, services?: LabServices, options?: LabOptions) {
  return createLab(createDefinition(options), container, services);
}
