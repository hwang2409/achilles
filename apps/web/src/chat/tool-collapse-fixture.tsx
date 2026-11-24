import React from "react";
import { createRoot } from "react-dom/client";
import { createRunStore } from "@fulcrum/core";
import { RunProvider, Timeline } from "@fulcrum/react";
import "@fulcrum/react/styles.css";
import "../globals.css";
import { CompactTool, ToolDisclosure } from "./CompactTool";

const store = createRunStore((job) => job());
const call = { id: "fixture", name: "achilles__create_page", arguments: { route: "/notes", title: "Notes" } };
const content = JSON.stringify({ title: "Notes", route: "/notes", description: "Synthetic raw content. ".repeat(70) }, null, 2);
store.dispatch({ type: "tool_start", tool_call: call });
store.dispatch({ type: "tool_end", tool_call: call, tool_result: { tool_call_id: call.id, content, is_error: false } });
store.dispatch({ type: "message_delta", message_id: "next", delta: "Next reply" });
createRoot(document.getElementById("root")!).render(<RunProvider store={store}>
  <ToolDisclosure sessionId="fixture"><Timeline data-chat-transcript="" virtual renderers={{ tool: CompactTool }} /></ToolDisclosure>
</RunProvider>);
