import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import AboutPage from "@/app/routes/about";
import DashboardPage from "@/app/routes/dashboard";
import PlatformPage from "@/app/routes/platform";
import PromptsPage from "@/app/routes/prompts";
import SettingsPage from "@/app/routes/settings";
import TerminalSessionsPage from "@/app/routes/terminal-sessions";
import ShellLayout from "@/components/layout/shell-layout";
import AppErrorPage from "@/features/errors/app-error";

const appRouter = createBrowserRouter([
  {
    path: "/",
    element: <ShellLayout />,
    errorElement: <AppErrorPage />,
    children: [
      { index: true, element: <PlatformPage /> },
      { path: "radar", element: <DashboardPage /> },
      { path: "dashboard", element: <DashboardPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "prompts", element: <PromptsPage /> },
      { path: "about", element: <AboutPage /> },
      { path: "terminal-sessions", element: <TerminalSessionsPage /> },
      { path: ":platform", element: <PlatformPage /> },
    ],
  },
  { path: "*", element: <Navigate replace to="/" /> },
]);

export default function AppRouter() {
  return <RouterProvider router={appRouter} />;
}
