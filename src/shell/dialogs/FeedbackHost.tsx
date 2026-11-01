/**
 * Where the three feedback surfaces are drawn: the first-run question, the
 * feedback dialog and the corner card.
 *
 * Mounted once per window by `App`, as a sibling of `WindowRoot`, for the
 * reason settings is (`docs/settings.md` §9): none of it is about a window's
 * clusters, and every caller that opens one is somewhere this is not.
 * Everything that changes a setting is handed in, because the settings session
 * is `App`'s and this region may not import the one that owns it.
 *
 * In this region rather than one of its own because two of the three are built
 * on `Dialog`, and the third is a dialog too — a non-modal one, which takes no
 * focus — so a separate region would have had to reach across for the frame.
 */
import { AnimatePresence } from "framer-motion";
import type { Delivery } from "../telemetry/feedback";
import { closeFeedback, useFeedbackSurface } from "../telemetry/surface";
import ConsentDialog from "./ConsentDialog";
import FeedbackDialog from "./FeedbackDialog";
import PromptCard from "./PromptCard";

export interface FeedbackHostProps {
  askConsent: boolean;
  onShare: (replay: boolean) => void;
  onDecline: () => void;
  onLater: () => void;
  delivery: Delivery;
  blockedBecause: string | null;
  onStopPrompts: () => void;
}

export default function FeedbackHost(props: FeedbackHostProps) {
  const surface = useFeedbackSurface();
  return (
    <>
      <AnimatePresence>
        {props.askConsent && (
          <ConsentDialog
            onShare={props.onShare}
            onDecline={props.onDecline}
            onLater={props.onLater}
          />
        )}
      </AnimatePresence>
      {/* Held back while the question is up: two modal dialogs at once would
          fight over the focus trap, and the answer decides what this one says
          about how a message travels. */}
      <AnimatePresence>
        {surface.dialog && !props.askConsent && (
          <FeedbackDialog
            request={surface.dialog}
            delivery={props.delivery}
            blockedBecause={props.blockedBecause}
            onClose={closeFeedback}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {surface.prompt && (
          <PromptCard
            key={surface.prompt.prompt.id}
            prompt={surface.prompt}
            onStopAsking={props.onStopPrompts}
          />
        )}
      </AnimatePresence>
    </>
  );
}
