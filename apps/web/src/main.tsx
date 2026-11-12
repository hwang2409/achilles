import { createRoot } from "react-dom/client";
import { initialState } from "@fulcrum/core";
import "./style.css";

function App() {
  return <main><h1>achilles</h1><p>the judge dashboard is coming soon.</p><p>fulcrum run state: {initialState.agent}</p></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
