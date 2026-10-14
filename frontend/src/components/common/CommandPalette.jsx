import { useEffect, useState } from "react";
import { fetchProjects } from "../../services/projectService.js";
import {
  ProjectsNavIcon,
  DeploymentsNavIcon,
  LogsNavIcon,
  SettingsNavIcon,
  PlusIcon,
  SearchIcon,
  ExternalLinkIcon,
  DockerIcon,
} from "./TechIcons.jsx";

export default function CommandPalette({ isOpen, onClose, navigate }) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [userProjects, setUserProjects] = useState([]);

  useEffect(() => {
    if (isOpen) {
      fetchProjects()
        .then((data) => {
          if (Array.isArray(data)) setUserProjects(data);
        })
        .catch(() => {});
    }
  }, [isOpen]);

  const baseCommands = [
    { label: "Go to Projects", path: "/projects", category: "Navigation", Icon: ProjectsNavIcon, shortcut: "G P" },
    { label: "Import / New Project", path: "/projects/new", category: "Action", Icon: PlusIcon, shortcut: "N" },
    { label: "View Deployments", path: "/deployments", category: "Navigation", Icon: DeploymentsNavIcon, shortcut: "G D" },
    { label: "View Latest Deployment", path: "/deployments/detail", category: "Deployments", Icon: DeploymentsNavIcon, shortcut: "D" },
    { label: "Live Runtime Logs", path: "/logs", category: "Navigation", Icon: LogsNavIcon, shortcut: "G L" },
    { label: "Workspace Settings", path: "/settings", category: "Navigation", Icon: SettingsNavIcon, shortcut: "G S" },
    { label: "Overview & Architecture", path: "/", category: "Information", Icon: ExternalLinkIcon, shortcut: "H" },
  ];

  const projectCommands = userProjects.map((p) => {
    const rawState = (p.state || p.status || "Ready").toLowerCase();
    const capState = rawState.charAt(0).toUpperCase() + rawState.slice(1);
    return {
      label: `Project: ${p.name}`,
      path: `/deployments/detail?project_id=${p.id}&project_name=${encodeURIComponent(p.name)}`,
      category: "Projects",
      Icon: DockerIcon,
      meta: `${capState} · Port :${p.port || 3000}`,
    };
  });

  const commands = [...baseCommands, ...projectCommands];

  const filtered = query.trim()
    ? commands.filter(
        (c) =>
          c.label.toLowerCase().includes(query.toLowerCase()) ||
          c.category.toLowerCase().includes(query.toLowerCase()) ||
          (c.meta && c.meta.toLowerCase().includes(query.toLowerCase()))
      )
    : commands;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    function handleKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onClose(!isOpen);
      } else if (e.key === "Escape" && isOpen) {
        onClose(false);
      } else if (isOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % Math.max(1, filtered.length));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + filtered.length) % Math.max(1, filtered.length));
        } else if (e.key === "Enter" && filtered[selectedIndex]) {
          e.preventDefault();
          onClose(false);
          navigate(filtered[selectedIndex].path);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, filtered, selectedIndex, navigate]);

  if (!isOpen) return null;

  return (
    <div className="cmd-backdrop" onClick={() => onClose(false)} role="dialog" aria-modal="true" aria-label="Command Palette">
      <div className="cmd-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cmd-input-wrap">
          <SearchIcon size={16} className="cmd-search-icon" />
          <input
            autoFocus
            className="cmd-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search workspace..."
          />
          <kbd className="cmd-esc" onClick={() => onClose(false)}>ESC</kbd>
        </div>

        <div className="cmd-list">
          {filtered.length > 0 ? (
            filtered.map((item, idx) => {
              const IconComp = item.Icon;
              const isSelected = selectedIndex === idx;
              return (
                <button
                  key={idx}
                  className={`cmd-item ${isSelected ? "selected" : ""}`}
                  onClick={() => {
                    onClose(false);
                    navigate(item.path);
                  }}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <span className="cmd-item-icon">
                    <IconComp size={15} />
                  </span>
                  <span className="cmd-item-label">{item.label}</span>
                  {item.meta && <span className="cmd-item-meta">{item.meta}</span>}
                  <span className="cmd-item-tag">{item.category}</span>
                  {item.shortcut && <kbd className="cmd-item-shortcut">{item.shortcut}</kbd>}
                </button>
              );
            })
          ) : (
            <div className="cmd-empty">No results found for “{query}”</div>
          )}
        </div>

        <div className="cmd-footer">
          <span>Navigate with <kbd>↑</kbd> <kbd>↓</kbd></span>
          <span>Select <kbd>↵</kbd></span>
          <span>Close <kbd>ESC</kbd></span>
        </div>
      </div>
    </div>
  );
}
