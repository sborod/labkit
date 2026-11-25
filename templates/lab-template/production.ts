import "labkit/labkit.css";
import { renderError } from "labkit";
import { mountLab } from "./mount.ts";

const container = document.getElementById("app");
if (!container) throw new Error("Missing #app");

try {
  const instance = mountLab(container);
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      void instance.dispose();
    });
  }
} catch (error) {
  renderError(container, error);
}
