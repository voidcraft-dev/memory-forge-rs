import { lazy } from "react";
import { Navigate, RouterProvider, createBrowserRouter } from "react-router";
import ShellLayout from "@/components/layout/shell-layout";
import { useDesktop } from "@/features/desktop/provider";

const DashboardPage = lazy(() => import("@/app/routes/dashboard"));
const SettingsPage = lazy(() => import("@/app/routes/settings"));
const PromptsPage = lazy(() => import("@/app/routes/prompts"));
const AboutPage = lazy(() => import("@/app/routes/about"));
const PlatformPage = lazy(() => import("@/app/routes/platform"));
const TerminalSessionsPage = lazy(() => import("@/app/routes/terminal-sessions"));

function TerminalSessionsRoute() {
  const { isRemote, remoteCapabilities } = useDesktop();
  if (isRemote && remoteCapabilities?.terminal !== true) {
    return <Navigate replace to="/" />;
  }
  return <TerminalSessionsPage />;
}

const createAppRouter = () =>
  createBrowserRouter([
    {
      path: "/",
      element: <ShellLayout />,
      children: [
        { index: true, element: <DashboardPage /> },
        { path: "settings", element: <SettingsPage /> },
        { path: "prompts", element: <PromptsPage /> },
        { path: "about", element: <AboutPage /> },
        { path: "terminal-sessions", element: <TerminalSessionsRoute /> },
        { path: ":platform", element: <PlatformPage /> },
      ],
    },
    { path: "*", element: <Navigate replace to="/" /> },
  ]);

export default function AppRouter() {
  return <RouterProvider router={createAppRouter()} />;
}
