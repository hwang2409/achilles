import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fulcrum/react/styles.css";
import "@fulcrum/react/themes.css";
import "./fonts.css";

createRoot(document.getElementById("root")!).render(<App />);
