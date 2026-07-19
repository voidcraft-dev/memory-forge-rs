import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router";
import { SessionList } from "@/features/session/session-list";
import { SessionDetail } from "@/features/session/session-detail";
import { EditLogPanel } from "@/features/session/edit-log-panel";
import { EditMessageDialog } from "@/features/session/edit-message-dialog";
import { useDesktop } from "@/features/desktop/provider";
import { cn } from "@/lib/utils";

export default function PlatformPage() {
  const { platform } = useParams<{ platform: string }>();
  const [searchParams] = useSearchParams();
  const { dispatch, state, isRemote } = useDesktop();
  const sessionFromUrl = searchParams.get("session");

  useEffect(() => {
    if (platform) {
      dispatch({ type: "setCurrentPlatform", payload: platform });
    }
  }, [platform, dispatch]);

  useEffect(() => {
    if (!isRemote || !platform || state.currentPlatform !== platform) return;
    if (sessionFromUrl === state.selectedSessionKey) return;
    dispatch({ type: "setSelectedSessionKey", payload: sessionFromUrl });
    if (!sessionFromUrl) {
      dispatch({ type: "setSessionDetail", payload: null });
      dispatch({ type: "setShowEditLog", payload: false });
    }
  }, [dispatch, isRemote, platform, sessionFromUrl, state.currentPlatform, state.selectedSessionKey]);

  return (
    <>
      <div className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden",
        isRemote ? "remote-platform-page" : "rounded-2xl border border-border/60 bg-white/4 md:rounded-[24px]",
      )}>
        <SessionList />
        <SessionDetail />
        {state.showEditLog && <EditLogPanel />}
      </div>
      {state.editingBlock && <EditMessageDialog />}
    </>
  );
}
