import ProjectsPage from "./ProjectsPage.jsx";
import NewProjectPage from "./NewProjectPage.jsx";
import DeploymentsPage from "./DeploymentsPage.jsx";
import DeploymentDetailPage from "./DeploymentDetailPage.jsx";
import LogsPage from "./LogsPage.jsx";
import SettingsPage from "./SettingsPage.jsx";

export default function DashboardPage({ path, navigate }) {
  if (path === "/projects/new") return <NewProjectPage navigate={navigate} />;
  if (path === "/deployments/detail") return <DeploymentDetailPage navigate={navigate} />;
  if (path === "/deployments") return <DeploymentsPage navigate={navigate} />;
  if (path === "/logs") return <LogsPage navigate={navigate} />;
  if (path === "/settings") return <SettingsPage navigate={navigate} />;
  return <ProjectsPage navigate={navigate} />;
}
