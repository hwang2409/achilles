import { GlobalRegistrator } from "@happy-dom/global-registrator";

const registrationKey = Symbol.for("achilles.happy-dom.registered");
const processState = globalThis as typeof globalThis & { [registrationKey]?: boolean };
if (!processState[registrationKey]) {
  GlobalRegistrator.register({ url: "http://localhost/" });
  processState[registrationKey] = true;
}
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
