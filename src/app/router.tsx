import { Navigate, RouterProvider, createBrowserRouter } from "react-router";
import DashboardPage from "@/app/routes/dashboard";
import SettingsPage from "@/app/routes/settings";
import PromptsPage from "@/app/routes/prompts";
import AboutPage from "@/app/routes/about";
import PlatformPage from "@/app/routes/platform";
import ShellLayout from "@/components/layout/shell-layout";

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
        { path: ":platform", element: <PlatformPage /> },
      ],
    },
    { path: "*", element: <Navigate replace to="/" /> },
  ]);

export default function AppRouter() {
  return <RouterProvider router={createAppRouter()} />;
}
