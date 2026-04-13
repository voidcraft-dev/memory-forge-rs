import { useEffect } from "react";
import { useParams } from "react-router";
import { SessionList } from "@/features/session/session-list";
import { SessionDetail } from "@/features/session/session-detail";
import { EditLogPanel } from "@/features/session/edit-log-panel";
import { EditMessageDialog } from "@/features/session/edit-message-dialog";
import { useDesktop } from "@/features/desktop/provider";

export default function PlatformPage() {
  const { platform } = useParams<{ platform: string }>();
  const { dispatch, state } = useDesktop();

  useEffect(() => {
    if (platform) {
      dispatch({ type: "setCurrentPlatform", payload: platform });
    }
  }, [platform, dispatch]);

  return (
    <>
      <div className="flex h-full min-h-0 flex-1 overflow-hidden rounded-[24px] border border-border/60 bg-white/4">
        <SessionList />
        <SessionDetail />
        {state.showEditLog && <EditLogPanel />}
      </div>
      {state.editingBlock && <EditMessageDialog />}
    </>
  );
}
