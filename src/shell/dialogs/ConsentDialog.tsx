/**
 * The first-run question: may this install send usage data?
 *
 * Asked once, and nothing is sent before it is answered — `telemetry.usageData`
 * starts at `ask`, and only `on` loads the SDK at all. Escape or a click on the
 * scrim is "not now", which records nothing and asks again next launch; only
 * the two buttons store an answer.
 *
 * The recording checkbox starts ticked and is beside the button it qualifies,
 * so what "Share" means is on screen at the moment it is pressed. Both choices
 * stay one click apart in Settings ▸ Usage data & feedback, and the dialog says
 * so, because a question that can only be answered once is not a fair one.
 */
import { useState } from "react";
import { PRODUCT_NAME } from "../../branding.generated";
import Dialog from "./Dialog";
import { UNMASK_ATTRIBUTE } from "../telemetry/analytics";
import "./feedback.css";

export interface ConsentDialogProps {
  onShare: (replay: boolean) => void;
  onDecline: () => void;
  onLater: () => void;
}

export default function ConsentDialog({ onShare, onDecline, onLater }: ConsentDialogProps) {
  const [replay, setReplay] = useState(true);
  return (
    <Dialog label="Share usage data" onCancel={onLater} className="feedback__consent">
      <div className="feedback__unmask" {...{ [UNMASK_ATTRIBUTE]: "" }}>
        <div className="k-dialog__header">Help shape {PRODUCT_NAME}?</div>
        <div className="k-dialog__body feedback__body">
          <p>
            {PRODUCT_NAME} can send its developers anonymous usage data: which parts get used, how
            often, and where people get stuck. It is how the next release decides what to fix first.
          </p>
          <ul className="feedback__list">
            <li>No file contents, project names, paths or anything you type.</li>
            <li>Identified by a random id made on this machine, never by name or email.</li>
            <li>Nothing has been sent yet, and nothing will be unless you choose Share.</li>
          </ul>
          <label className="feedback__check">
            <input
              type="checkbox"
              checked={replay}
              onChange={(event) => setReplay(event.target.checked)}
            />
            <span>
              Include session recordings — the main window&apos;s layout and clicks, with every
              piece of text masked. App panes are not recorded.
            </span>
          </label>
          <p className="feedback__fine">
            Change your mind any time in Settings ▸ Usage data &amp; feedback.
          </p>
        </div>
        <div className="k-dialog__footer">
          <button type="button" className="k-btn k-btn--secondary" onClick={onDecline}>
            Don&apos;t share
          </button>
          <button type="button" className="k-btn k-btn--primary" onClick={() => onShare(replay)}>
            Share usage data
          </button>
        </div>
      </div>
    </Dialog>
  );
}
