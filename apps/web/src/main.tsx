import { createRoot } from "react-dom/client";
import "@fulcrum/react/styles.css";
import "@fulcrum/react/themes.css";
import "@fulcrum/highlight/styles.css";
import "./globals.css";
import "./fonts.css";
import { SurfaceRouter } from "./surface/SurfaceRouter";

createRoot(document.getElementById("root")!).render(<SurfaceRouter />);
