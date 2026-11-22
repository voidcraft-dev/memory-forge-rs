import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useDesktop } from "@/features/desktop/provider";

export default function TerminalSessionsPage() {
  const navigate = useNavigate();
  const { dispatch } = useDesktop();

  useEffect(() => {
    dispatch({ type: "setPtyBayMaximized", payload: true });
    navigate("/", { replace: true });
  }, [dispatch, navigate]);

  return null;
}
