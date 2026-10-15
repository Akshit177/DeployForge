// frontend/src/components/common/CommandPalette.jsx
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { fetchProjects } from '../../services/projectService.js';
import {
  ProjectsNavIcon,
  DeploymentsNavIcon,
  LogsNavIcon,
  SettingsNavIcon,
  PlusIcon,
  ExternalLinkIcon,
  DockerIcon,
} from './TechIcons.jsx';

export default function CommandPalette({ isOpen, onClose, onNavigate, navigate, items = [] }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [userProjects, setUserProjects] = useState([]);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (isOpen && items.length === 0) {
      fetchProjects()
        .then((data) => {
          if (Array.isArray(data)) setUserProjects(data);
        })
        .catch(() => {});
    }
  }, [isOpen, items.length]);

  const defaultCommands = useMemo(() => {
    const base = [
      { id: 'nav-projects', label: 'Go to Projects', path: '/projects', category: 'Navigation', Icon: ProjectsNavIcon, shortcut: 'G P' },
      { id: 'act-new-project', label: 'Import / New Project', path: '/projects/new', category: 'Action', Icon: PlusIcon, shortcut: 'N' },
      { id: 'nav-deployments', label: 'View Deployments', path: '/deployments', category: 'Navigation', Icon: DeploymentsNavIcon, shortcut: 'G D' },
      { id: 'nav-detail', label: 'View Latest Deployment', path: '/deployments/detail', category: 'Deployments', Icon: DeploymentsNavIcon, shortcut: 'D' },
      { id: 'nav-logs', label: 'Live Runtime Logs', path: '/logs', category: 'Navigation', Icon: LogsNavIcon, shortcut: 'G L' },
      { id: 'nav-settings', label: 'Workspace Settings', path: '/settings', category: 'Navigation', Icon: SettingsNavIcon, shortcut: 'G S' },
      { id: 'nav-home', label: 'Overview & Architecture', path: '/', category: 'Information', Icon: ExternalLinkIcon, shortcut: 'H' },
    ];

    const projectCmds = userProjects.map((p) => {
      const rawState = (p.state || p.status || 'Ready').toLowerCase();
      const capState = rawState.charAt(0).toUpperCase() + rawState.slice(1);
      return {
        id: `proj-${p.id || p.name}`,
        label: `Project: ${p.name}`,
        path: `/deployments/detail?project_id=${p.id}&project_name=${encodeURIComponent(p.name)}`,
        category: 'Projects',
        Icon: DockerIcon,
        shortcut: `${capState} · :${p.port || 3000}`,
      };
    });

    return [...base, ...projectCmds];
  }, [userProjects]);

  const sourceItems = items.length > 0 ? items : defaultCommands;

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sourceItems;
    return sourceItems.filter(
      (item) =>
        item.label.toLowerCase().includes(q) ||
        (item.category && item.category.toLowerCase().includes(q)) ||
        (item.keywords && item.keywords.toLowerCase().includes(q)) ||
        (item.path && item.path.toLowerCase().includes(q))
    );
  }, [sourceItems, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, isOpen]);

  // Scroll active item into view
  useEffect(() => {
    if (isOpen && listRef.current) {
      const activeEl = listRef.current.querySelector('.df-cmd-item--active, .cmd-item.selected');
      if (activeEl && typeof activeEl.scrollIntoView === 'function') {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [activeIndex, isOpen]);

  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement;
      document.body.style.overflow = 'hidden';
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      document.body.style.overflow = '';
      setQuery('');
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
        previousFocusRef.current.focus();
      }
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleClose = () => {
    if (typeof onClose === 'function') {
      onClose(false);
    }
  };

  const handleSelect = (item) => {
    if (typeof onNavigate === 'function') {
      onNavigate(item);
    } else if (typeof navigate === 'function') {
      navigate(item.path || item);
    }
    handleClose();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
      return;
    }
    if (filteredItems.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % filteredItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
    } else if (e.key === 'Enter' && filteredItems[activeIndex]) {
      e.preventDefault();
      handleSelect(filteredItems[activeIndex]);
    } else if (e.key === 'Tab') {
      // Focus containment
      e.preventDefault();
      inputRef.current?.focus();
    }
  };

  return (
    <div
      className="df-cmd-backdrop cmd-backdrop"
      onClick={handleClose}
      role="presentation"
    >
      <div
        className="df-cmd-dialog cmd-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Command Palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="df-cmd-search cmd-input-wrap">
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search projects, deployments, logs..."
            className="df-cmd-input cmd-input"
            aria-label="Search workspace commands"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls="cmd-listbox"
            aria-activedescendant={
              filteredItems[activeIndex]
                ? `cmd-item-${filteredItems[activeIndex].id || activeIndex}`
                : undefined
            }
          />
          <button
            type="button"
            className="df-kbd df-kbd--esc cmd-esc"
            onClick={handleClose}
            aria-label="Close command palette"
          >
            ESC
          </button>
        </div>

        <ul className="df-cmd-list cmd-list" id="cmd-listbox" ref={listRef} role="listbox" aria-label="Command suggestions">
          {filteredItems.length === 0 ? (
            <li className="df-cmd-empty cmd-empty" role="option" aria-selected="false">
              No matching commands or resources for "{query}"
            </li>
          ) : (
            filteredItems.map((item, idx) => {
              const isSelected = idx === activeIndex;
              const IconComp = item.Icon;
              const itemId = item.id || `item-${idx}`;
              return (
                <li
                  key={itemId}
                  id={`cmd-item-${itemId}`}
                  role="option"
                  aria-selected={isSelected}
                  className={`df-cmd-item cmd-item ${isSelected ? 'df-cmd-item--active selected' : ''}`.trim()}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => handleSelect(item)}
                >
                  {IconComp && (
                    <span className="cmd-item-icon" aria-hidden="true" style={{ display: 'inline-flex', marginRight: '8px', color: 'var(--text-muted)' }}>
                      <IconComp size={15} />
                    </span>
                  )}
                  <span className="df-cmd-item__label cmd-item-label" style={{ flex: 1 }}>{item.label}</span>
                  {item.category && <span className="cmd-item-tag" style={{ marginRight: '8px', fontSize: '11px', color: 'var(--text-muted)' }}>{item.category}</span>}
                  {item.shortcut && <kbd className="df-kbd cmd-item-shortcut">{item.shortcut}</kbd>}
                </li>
              );
            })
          )}
        </ul>

        <div className="cmd-footer" aria-hidden="true">
          <span>Navigate with <kbd>↑</kbd> <kbd>↓</kbd></span>
          <span>Select <kbd>↵</kbd></span>
          <span>Close <kbd>ESC</kbd></span>
        </div>
      </div>
    </div>
  );
}
