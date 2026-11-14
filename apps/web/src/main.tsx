import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fulcrum/react/styles.css";
import "@fulcrum/react/themes.css";
const theme = new URLSearchParams(location.search).get("theme");
if (theme) document.documentElement.dataset.fulcrumTheme = theme;
createRoot(document.getElementById("root")!).render(<App />);
