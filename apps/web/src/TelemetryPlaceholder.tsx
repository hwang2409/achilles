import type { ZetaClient } from "@fulcrum/zeta";
import { supportsFeature, TELEMETRY_FEATURE, type ConnectionState } from "./zeta/connection";

export function TelemetryPlaceholder({ client, state }: { client: ZetaClient | null; state: ConnectionState }) {
  if (!client) {
    const connecting = state.phase === "connected" || (state.phase === "connecting" && state.attempt === 0);
    return <div className="full-state"><p role="status">{connecting ? "connecting to zeta…" : "could not connect to zeta · retrying automatically"}</p></div>;
  }
  if (supportsFeature(client, TELEMETRY_FEATURE)) {
    return <div className="full-state"><p role="status">zeta is ready for telemetry. the telemetry views are not in this build yet.</p></div>;
  }
  const stateFeature = "state_read_v1";
  return (
    <div className="telemetry-placeholder">
      <section className="telemetry-notice">
        <p className="telemetry-eyebrow" role="status">telemetry · needs a newer zeta</p>
        <h1>this zeta can't show telemetry yet</h1>
        <p className="telemetry-lead">achilles reads telemetry from zeta through <code>telemetry_read_v1</code>. the zeta that achilles talks to did not offer it. chats, pages and agents still work.</p>
        <dl>
          <dt>zeta serve</dt><dd>connected{client.protocolVersion && ` · protocol ${client.protocolVersion}`}</dd>
          <dt><code>{TELEMETRY_FEATURE}</code></dt><dd className="telemetry-warn"><span aria-hidden="true">■ </span>not offered</dd>
          <dt><code>{stateFeature}</code></dt>
          {supportsFeature(client, stateFeature) ? <dd>offered</dd> : <dd className="telemetry-warn"><span aria-hidden="true">■ </span>not offered · projects also off</dd>}
        </dl>
        <h2>to fix it</h2>
        <ol>
          <li>update zeta to a version that offers <code>telemetry_read_v1</code></li>
          <li>restart <code>zeta serve</code> · achilles connects again by itself</li>
        </ol>
        <div className="telemetry-actions">
          <button type="button" onClick={() => location.reload()}>check again</button>
          <a href="/">back to chats</a>
        </div>
      </section>
    </div>
  );
}
