import { GlobalRegistrator } from "@happy-dom/global-registrator";

const registrationKey = Symbol.for("achilles.happy-dom.registered");
const processState = globalThis as typeof globalThis & { [registrationKey]?: boolean };
if (!processState[registrationKey]) {
  GlobalRegistrator.register();
  processState[registrationKey] = true;
}
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
if (actEnvironment.IS_REACT_ACT_ENVIRONMENT !== true) throw new Error("shared test DOM must enable React act environment");
