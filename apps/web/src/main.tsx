import { createRoot } from "react-dom/client";
import { SurfaceRouter } from "./surface/SurfaceRouter";
import "@fulcrum/react/styles.css";
import "@fulcrum/react/themes.css";
import "@fulcrum/highlight/styles.css";
import "./fonts.css";

createRoot(document.getElementById("root")!).render(<SurfaceRouter />);
