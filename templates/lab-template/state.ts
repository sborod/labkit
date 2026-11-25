export interface LabState {
  level: number;
}

export const DEFAULT_LEVEL = 0.5;

export function createState(): LabState {
  return { level: DEFAULT_LEVEL };
}
