/**
 * Above the usage data rows: whether this build can send at all, the id it
 * sends as, and the way to send feedback by hand.
 *
 * A panel rather than a setting because none of it is a choice. Whether a
 * build can send is decided when it is built (`telemetry::decide`), and a
 * switch that cannot do anything is the row `docs/settings.md` §1 forbids — so
 * when this build cannot send, the reason is shown here instead, above three
 * rows that will not do anything until it can.
 *
 * The id is shown so a person can quote it in a support thread and have their
 * own sessions found; it identifies the install, never the person.
 */
import { useEffect, useState } from "react";
import { telemetryConfig, type TelemetryConfig } from "../../bindings";
import { openFeedback } from "../telemetry/surface";

export default function TelemetryPanel() {
  const [config, setConfig] = useState<TelemetryConfig | null>(null);

  useEffect(() => {
    let live = true;
    telemetryConfig()
      .then((next) => live && setConfig(next))
      .catch((err: unknown) => console.error("veistra: could not read the usage config:", err));
    return () => {
      live = false;
    };
  }, []);

  const sink = config?.sink;
  const description =
    sink === undefined
      ? "Reading this build's configuration…"
      : sink.state === "off"
        ? sink.reason
        : `Sends to ${new URL(sink.host).host} as install ${config?.installId.slice(0, 8)}, when the switch below says it may.`;

  return (
    <div className="setting">
      <div className="setting__label">
        <span className="setting__title">This build</span>
        <span className="setting__description">{description}</span>
      </div>
      <div className="setting__control">
        <button
          type="button"
          className="k-btn k-btn--secondary k-btn--sm"
          onClick={() => openFeedback({ source: "settings", feature: null })}
        >
          Send feedback…
        </button>
      </div>
      <div className="setting__reset-slot" />
    </div>
  );
}
