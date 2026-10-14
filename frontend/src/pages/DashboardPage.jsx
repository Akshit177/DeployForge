import ProjectsPage from "./ProjectsPage.jsx";
import NewProjectPage from "./NewProjectPage.jsx";
import DeploymentsPage from "./DeploymentsPage.jsx";
import DeploymentDetailPage from "./DeploymentDetailPage.jsx";
import LogsPage from "./LogsPage.jsx";
import SettingsPage from "./SettingsPage.jsx";

export default function DashboardPage({ path, navigate }) {
  const [pathname, search] = path.split("?");
  const searchParams = new URLSearchParams(search || "");

  if (pathname === "/projects/new") return <NewProjectPage navigate={navigate} searchParams={searchParams} />;
  if (pathname === "/deployments/detail") return <DeploymentDetailPage navigate={navigate} searchParams={searchParams} />;
  if (pathname === "/deployments") return <DeploymentsPage navigate={navigate} searchParams={searchParams} />;
  if (pathname === "/logs") return <LogsPage navigate={navigate} searchParams={searchParams} />;
  if (pathname === "/settings") return <SettingsPage navigate={navigate} searchParams={searchParams} />;
  return <ProjectsPage navigate={navigate} searchParams={searchParams} />;
}
