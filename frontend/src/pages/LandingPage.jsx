import { useState, useEffect, useRef } from "react";
import BrandLogo from "../components/common/BrandLogo.jsx";
import {
  GitHubIcon,
  DockerIcon,
  NginxIcon,
  TerminalIcon,
  NodeIcon,
  RedisIcon,
  PostgresIcon,
  CppIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  ContainerIcon,
  PackageIcon,
} from "../components/common/TechIcons.jsx";

/**
 * DeployForge Landing Page
 * Base: Figma design frame (Code to live)
 * Aesthetics & Interaction: Vercel & Dropbox inspired developer craftsmanship
 */
export default function LandingPage({ navigate }) {
  const [activeStage, setActiveStage] = useState(1);
  const [autoPlay, setAutoPlay] = useState(true);
  const [copiedCmd, setCopiedCmd] = useState(false);

  // Terminal steps data structure designed for easy connection to backend SSE / WebSockets
  const stageDefinitions = [
    {
      id: 1,
      tag: "01 Connect repository",
      title: "From source code. To something live.",
      command: "$ deployforge deploy --repo github.com/acme/web-app",
      steps: [
        { text: "Cloning repository github.com/acme/web-app...", status: "done", time: "0.8s" },
        { text: "Checked out commit 3f9a2c1 (branch main)", status: "done", time: "1.2s" },
        { text: "Repository manifest validated successfully", status: "done", time: "1.4s" },
      ],
      result: "✔ Repository connected & inspected",
      meta: "Commit: 3f9a2c1 · Branch: main",
    },
    {
      id: 2,
      tag: "02 Automated build",
      title: "Isolated builds. Zero configuration.",
      command: "$ docker build -t web-app:3f9a2c1 .",
      steps: [
        { text: "Root Dockerfile validated in isolated workspace context", status: "done", time: "1.8s" },
        { text: "C++ deployment worker assigned job from Redis stream", status: "done", time: "2.1s" },
        { text: "OCI image build initiated via Docker Engine API", status: "done", time: "4.5s" },
        { text: "Multi-stage build layers compiled & cached successfully", status: "done", time: "9.2s" },
      ],
      result: "✔ Container image df-app-3f9a2c1 built & tagged",
      meta: "Engine: Docker API · Worker: C++",
    },
    {
      id: 3,
      tag: "03 Upstream routing",
      title: "Instant traffic routing. Edge SSL.",
      command: "$ nginx -t && systemctl reload nginx",
      steps: [
        { text: "Spawning container web-app-131 on port 3000...", status: "done", time: "14.1s" },
        { text: "Health probe GET :3000/health responded 200 OK", status: "done", time: "14.5s" },
        { text: "Nginx reverse proxy upstream dynamically bonded", status: "done", time: "15.0s" },
        { text: "Public vanity domain issued: web-app.deployforge.app", status: "done", time: "15.2s" },
      ],
      result: "✔ Deployed & live on :3000 → 35921",
      meta: "Serving: web-app.deployforge.app",
    },
  ];

  // Auto-play through stages unless user manually selects one
  useEffect(() => {
    if (!autoPlay) return;
    const interval = setInterval(() => {
      setActiveStage((prev) => (prev % stageDefinitions.length) + 1);
    }, 5500);
    return () => clearInterval(interval);
  }, [autoPlay, stageDefinitions.length]);

  const handleStageSelect = (stageId) => {
    setAutoPlay(false);
    setActiveStage(stageId);
  };

  const handleCopyCmd = () => {
    navigator.clipboard?.writeText("curl -fsSL https://deployforge.app/install.sh | bash");
    setCopiedCmd(true);
    setTimeout(() => setCopiedCmd(false), 2000);
  };

  const scrollToSection = (id) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const currentStage = stageDefinitions.find((s) => s.id === activeStage) || stageDefinitions[0];

  return (
    <div className="landing-page-root">
      {/* Top Navigation Bar */}
      <header className="landing-nav-bar">
        <div className="landing-nav-container">
          {/* Brand Logo & Name */}
          <div
            className="landing-brand-link"
            onClick={() => navigate("/")}
            role="button"
            tabIndex={0}
            aria-label="DeployForge home"
          >
            <BrandLogo size={26} />
          </div>

          {/* Center Links */}
          <nav className="landing-center-nav" aria-label="Main Navigation">
            <button
              type="button"
              className="nav-item-btn"
              onClick={() => scrollToSection("features")}
            >
              Platform
            </button>
            <button
              type="button"
              className="nav-item-btn"
              onClick={() => scrollToSection("workflow")}
            >
              Workflow
            </button>
            <button
              type="button"
              className="nav-item-btn"
              onClick={() => scrollToSection("architecture")}
            >
              Architecture
            </button>
            <a
              href="https://github.com"
              target="_blank"
              rel="noreferrer"
              className="nav-item-btn"
            >
              GitHub <ExternalLinkIcon size={12} className="ml-1" />
            </a>
          </nav>

          {/* Right Action CTAs */}
          <div className="landing-right-actions">
            <button
              type="button"
              className="btn-ghost-nav"
              onClick={() => navigate("/login")}
            >
              Log in
            </button>
            <button
              type="button"
              className="btn-primary-nav"
              onClick={() => navigate("/projects")}
            >
              Launch Console <span>→</span>
            </button>
          </div>
        </div>
      </header>

      <main id="main-content">
        {/* =========================================================================
            HERO SECTION
            ========================================================================= */}
        <section className="hero-section">
          <div className="hero-ambient-glow" aria-hidden="true" />

          {/* GitHub-first Pill Badge */}
          <div className="hero-pill-badge">
            <GitHubIcon size={14} className="badge-icon" />
            <span>GITHUB-FIRST DEPLOYMENTS</span>
          </div>

          {/* Main Display Headline */}
          <h1 className="hero-display-headline">
            Code. Deploy. Done.
          </h1>

          {/* Subtitle */}
          <p className="hero-editorial-subtitle">
            A lightweight PaaS for container-based applications. Connect your GitHub repository,
            configure your build, and DeployForge handles the rest.
          </p>

          {/* Hero Action Buttons */}
          <div className="hero-cta-group">
            <button
              type="button"
              className="hero-btn-primary"
              onClick={() => navigate("/projects")}
            >
              Launch Console <span>→</span>
            </button>
            <button
              type="button"
              className="hero-btn-secondary"
              onClick={() => scrollToSection("architecture")}
            >
              Read the docs
            </button>
          </div>

          {/* Monospace Architectural Tagline */}
          <div className="hero-mono-tagline">
            <span>YOUR REPOSITORY</span>
            <span className="mono-arrow">→</span>
            <span>YOUR CONTAINER</span>
            <span className="mono-arrow">→</span>
            <span>YOUR LIVE URL</span>
          </div>

          {/* =========================================================================
              INTERACTIVE DEPLOYMENT CANVAS & TERMINAL
              ========================================================================= */}
          <div className="hero-canvas-wrap">
            <div className="hero-interactive-window">
              {/* Window Chrome / Top Header */}
              <div className="window-top-bar">
                <div className="window-repo-tag">
                  <GitBranchIcon size={14} className="branch-svg" />
                  <span className="repo-slug">github.com/acme/web-app</span>
                  <span className="dot-sep">·</span>
                  <span className="commit-hash">commit 3f9a2c1</span>
                </div>

                <div className="window-right-meta">
                  <span className="live-demo-pill">
                    <span className="pulsing-green-dot" />
                    <span>Live demo</span>
                  </span>
                </div>
              </div>

              {/* Split Body: Terminal Console (Left) + Interactive Stage Cards (Right) */}
              <div className="window-split-body">
                {/* Left: Terminal Console */}
                <div className="terminal-pane">
                  <div className="terminal-header-line">
                    <span className="term-prompt">$</span>
                    <span className="term-cmd">deployforge deploy</span>
                    <button
                      type="button"
                      className="term-copy-btn"
                      onClick={handleCopyCmd}
                      title="Copy CLI command"
                    >
                      {copiedCmd ? "Copied!" : "Copy"}
                    </button>
                  </div>

                  <div className="terminal-logs-list">
                    <div className="log-entry done">
                      <span className="check-mark">✔</span>
                      <span className="log-msg">Cloning repository...</span>
                    </div>
                    <div className="log-entry done">
                      <span className="check-mark">✔</span>
                      <span className="log-msg">Preparing build environment...</span>
                    </div>
                    <div className="log-entry done">
                      <span className="check-mark">✔</span>
                      <span className="log-msg">Building application image...</span>
                    </div>
                    <div className="log-entry done">
                      <span className="check-mark">✔</span>
                      <span className="log-msg">Running container...</span>
                    </div>
                    <div className="log-entry done">
                      <span className="check-mark">✔</span>
                      <span className="log-msg">Deploying to production...</span>
                    </div>
                    <div className="log-entry active-deployed">
                      <span className="check-mark">✔</span>
                      <span className="log-msg text-highlight">Deployed: 3000:35921</span>
                    </div>
                  </div>

                  <div className="terminal-footer-meta">
                    <TerminalIcon size={13} className="text-muted" />
                    <span>Worker worker-1 · Redis queue · Node.js 22 Alpine</span>
                  </div>
                </div>

                {/* Right: Live Interactive Workflow Stages */}
                <div className="interactive-stage-pane">
                  <div className="stage-top-header">
                    <div className="stage-pill-badge">
                      <span className="mini-dot green" />
                      <span>Deployment #131 · 42s</span>
                    </div>
                    <h3 className="stage-hero-heading">
                      From source code.<br />To something live.
                    </h3>
                  </div>

                  <div className="stage-nav-list" role="tablist">
                    {stageDefinitions.map((stage) => {
                      const isSelected = activeStage === stage.id;
                      return (
                        <button
                          key={stage.id}
                          type="button"
                          className={`stage-nav-item ${isSelected ? "selected" : ""}`}
                          onClick={() => handleStageSelect(stage.id)}
                          role="tab"
                          aria-selected={isSelected}
                        >
                          <span className="stage-nav-text">{stage.tag}</span>
                          <span className="stage-nav-arrow">→</span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="stage-callout-footer">
                    <p className="callout-desc">{currentStage.meta}</p>
                    <button
                      type="button"
                      className="view-pipeline-link"
                      onClick={() => navigate("/deployments/detail")}
                    >
                      View live pipeline <span>↗</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* 4-Item Capabilities Strip (Monochrome SVGs with hover glow) */}
            <div id="features" className="capabilities-strip">
              <div className="capability-item">
                <div className="cap-icon-box github-glow">
                  <GitHubIcon size={24} />
                </div>
                <div className="cap-info">
                  <h4 className="cap-title">GitHub-first</h4>
                  <p className="cap-desc">Connect any public repository</p>
                </div>
              </div>

              <div className="capability-item">
                <div className="cap-icon-box docker-glow">
                  <DockerIcon size={24} />
                </div>
                <div className="cap-info">
                  <h4 className="cap-title">Docker native</h4>
                  <p className="cap-desc">Build from any Dockerfile</p>
                </div>
              </div>

              <div className="capability-item">
                <div className="cap-icon-box terminal-glow">
                  <TerminalIcon size={24} />
                </div>
                <div className="cap-info">
                  <h4 className="cap-title">Live build logs</h4>
                  <p className="cap-desc">Follow every build step</p>
                </div>
              </div>

              <div className="capability-item">
                <div className="cap-icon-box nginx-glow">
                  <NginxIcon size={24} />
                </div>
                <div className="cap-info">
                  <h4 className="cap-title">Nginx routing</h4>
                  <p className="cap-desc">Public traffic, routed</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* =========================================================================
            SECTION 01 / HOW IT WORKS (Horizontal Workflow Rows)
            ========================================================================= */}
        <section id="workflow" className="workflow-section-block">
          <div className="section-inner-container">
            <div className="section-header-meta">
              <span className="section-index-badge">01 / HOW IT WORKS</span>
              <h2 className="section-primary-heading">
                From repository to live URL in minutes.
              </h2>
              <p className="section-secondary-lead">
                DeployForge automates the container lifecycle so you can ship faster without
                managing the underlying infrastructure.
              </p>
            </div>

            {/* 4 Horizontal Workflow Rows matching Figma layout */}
            <div className="workflow-rows-list">
              {/* Row 01: Connect repository */}
              <div className="workflow-row-item">
                <div className="row-col-num">01</div>
                <div className="row-col-title-group">
                  <GitHubIcon size={20} className="row-tech-svg" />
                  <h3 className="row-title">Connect repository</h3>
                </div>
                <div className="row-col-description">
                  <p>Link your GitHub repository and choose the branch you want to deploy.</p>
                </div>
                <div className="row-col-tag">
                  <code>github.com/acme/web-app</code>
                </div>
              </div>

              {/* Row 02: Build and package */}
              <div className="workflow-row-item">
                <div className="row-col-num">02</div>
                <div className="row-col-title-group">
                  <DockerIcon size={20} className="row-tech-svg" />
                  <h3 className="row-title">Build and package</h3>
                </div>
                <div className="row-col-description">
                  <p>
                    DeployForge inspects your repo, detects dependencies, and prepares the container
                    image.
                  </p>
                </div>
                <div className="row-col-tag">
                  <code>Docker · Alpine</code>
                </div>
              </div>

              {/* Row 03: Deploy container */}
              <div className="workflow-row-item">
                <div className="row-col-num">03</div>
                <div className="row-col-title-group">
                  <ContainerIcon size={20} className="row-tech-svg" />
                  <h3 className="row-title">Deploy container</h3>
                </div>
                <div className="row-col-description">
                  <p>
                    The C++ deployment worker manages the container lifecycle through the Docker
                    engine API.
                  </p>
                </div>
                <div className="row-col-tag">
                  <code>Port: 3000</code>
                </div>
              </div>

              {/* Row 04: Route traffic */}
              <div className="workflow-row-item">
                <div className="row-col-num">04</div>
                <div className="row-col-title-group">
                  <NginxIcon size={20} className="row-tech-svg" />
                  <h3 className="row-title">Route traffic</h3>
                </div>
                <div className="row-col-description">
                  <p>Nginx routes public requests to the newly spawned application container.</p>
                </div>
                <div className="row-col-tag">
                  <code>web-app.deployforge.app</code>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* =========================================================================
            SECTION 02 / ARCHITECTURE (Two Planes. One Reliable Deployment)
            ========================================================================= */}
        <section id="architecture" className="architecture-section-block">
          <div className="section-inner-container">
            <div className="arch-top-meta">
              <span className="section-index-badge">02 / ARCHITECTURE</span>
              <div className="arch-title-grid">
                <h2 className="arch-heading-large">
                  Two planes.<br />One reliable deployment.
                </h2>
                <p className="arch-lead-paragraph">
                  Control plane and data plane, designed for reliability. DeployForge separates
                  deployment orchestration from the containers that run your application and serve
                  public traffic.
                </p>
              </div>
            </div>

            {/* System Map Card */}
            <div className="system-architecture-map">
              <div className="architecture-planes-split">
                {/* Left: Control Plane */}
                <div className="arch-plane-column control-plane">
                  <div className="plane-column-header">
                    <span className="plane-badge-label">CONTROL PLANE</span>
                    <span className="plane-sub-text">Orchestration</span>
                  </div>

                  {/* Node Pair 1: Node.js / Express -> Redis */}
                  <div className="arch-node-connector-row">
                    <div className="arch-node-cell">
                      <div className="node-title-row">
                        <NodeIcon size={18} className="node-icon" />
                        <strong>Node.js / Express</strong>
                      </div>
                      <p>Auth & deployment requests</p>
                    </div>

                    <span className="arch-flow-arrow">→</span>

                    <div className="arch-node-cell">
                      <div className="node-title-row">
                        <RedisIcon size={18} className="node-icon" />
                        <strong>Redis</strong>
                      </div>
                      <p>Sessions, queue & hot state</p>
                    </div>
                  </div>

                  {/* Flow label */}
                  <div className="arch-flow-divider">
                    <span>EVENTS ↓ ASYNCHRONOUS PERSISTENCE</span>
                  </div>

                  {/* Node Pair 2: PostgreSQL -> Persistence Worker */}
                  <div className="arch-node-connector-row">
                    <div className="arch-node-cell">
                      <div className="node-title-row">
                        <PostgresIcon size={18} className="node-icon" />
                        <strong>PostgreSQL</strong>
                      </div>
                      <p>Durable source of truth</p>
                    </div>

                    <span className="arch-flow-arrow">→</span>

                    <div className="arch-node-cell">
                      <div className="node-title-row">
                        <TerminalIcon size={18} className="node-icon" />
                        <strong>Persistence worker</strong>
                      </div>
                      <p>Event-driven writes</p>
                    </div>
                  </div>

                  <div className="plane-footer-note">
                    <span>Worker poll queue is free from system harness</span>
                  </div>
                </div>

                {/* Right: Data Plane */}
                <div className="arch-plane-column data-plane">
                  <div className="plane-column-header">
                    <span className="plane-badge-label">DATA PLANE</span>
                    <span className="plane-sub-text">Execution</span>
                  </div>

                  {/* Node Pair 1: C++ worker -> Docker Engine API */}
                  <div className="arch-node-connector-row">
                    <div className="arch-node-cell">
                      <div className="node-title-row">
                        <CppIcon size={18} className="node-icon" />
                        <strong>C++ worker</strong>
                      </div>
                      <p>Repository prep & execution</p>
                    </div>

                    <span className="arch-flow-arrow">→</span>

                    <div className="arch-node-cell">
                      <div className="node-title-row">
                        <DockerIcon size={18} className="node-icon" />
                        <strong>Docker Engine API</strong>
                      </div>
                      <p>Container lifecycle</p>
                    </div>
                  </div>

                  {/* Flow label */}
                  <div className="arch-flow-divider">
                    <span>PUBLIC REQUESTS ↓ REVERSE PROXY</span>
                  </div>

                  {/* Node Pair 2: Nginx -> App containers */}
                  <div className="arch-node-connector-row">
                    <div className="arch-node-cell">
                      <div className="node-title-row">
                        <NginxIcon size={18} className="node-icon" />
                        <strong>Nginx</strong>
                      </div>
                      <p>Public entry point</p>
                    </div>

                    <span className="arch-flow-arrow">→</span>

                    <div className="arch-node-cell">
                      <div className="node-title-row">
                        <ContainerIcon size={18} className="node-icon" />
                        <strong>App containers</strong>
                      </div>
                      <p>Isolated applications</p>
                    </div>
                  </div>

                  <div className="plane-footer-note">
                    <span>Docker engine manages port binding directly</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Two Narrative Detail Columns Underneath */}
            <div className="arch-narrative-columns">
              {/* Left Column: Orchestration */}
              <div className="narrative-col">
                <h3 className="narrative-title">Orchestration stays in control.</h3>
                <p className="narrative-lead">
                  The control plane is built on Node.js and Express. It handles GitHub
                  authentication, repository connection, deployment configuration, and job submission
                  to Redis.
                </p>

                <ul className="narrative-bullet-list">
                  <li>
                    <span className="bullet-check">✓</span>
                    <span>PostgreSQL is the durable source of truth</span>
                  </li>
                  <li>
                    <span className="bullet-check">✓</span>
                    <span>Redis holds sessions, queues, hot state, and events</span>
                  </li>
                  <li>
                    <span className="bullet-check">✓</span>
                    <span>All user-facing operations are authenticated and logged centrally</span>
                  </li>
                </ul>

                <div className="narrative-sub-box">
                  <span className="sub-box-title">PERSISTENCE SEPARATED</span>
                  <p>
                    A dedicated worker consumes deployment events and writes to PostgreSQL so hot paths
                    are never blocked.
                  </p>
                </div>
              </div>

              {/* Right Column: Execution */}
              <div className="narrative-col">
                <h3 className="narrative-title">Execution has its own space.</h3>
                <p className="narrative-lead">
                  The data plane runs entirely standalone from orchestration and serves public traffic.
                  The C++ deployment worker processes deployment jobs and manages Docker lifecycle
                  operations.
                </p>

                <ul className="narrative-bullet-list">
                  <li>
                    <span className="bullet-check">✓</span>
                    <span>Docker Engine API manages container lifecycle</span>
                  </li>
                  <li>
                    <span className="bullet-check">✓</span>
                    <span>Nginx reverse proxy routes public requests to app containers</span>
                  </li>
                  <li>
                    <span className="bullet-check">✓</span>
                    <span>Live build logs and deployment state track execution</span>
                  </li>
                </ul>

                <div className="narrative-sub-box">
                  <span className="sub-box-title">DATA PLANE ISOLATION</span>
                  <p>
                    Public requests hit Nginx directly, with zero overhead from the control plane in
                    the critical request path.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* =========================================================================
            SECTION 03 / START DEPLOYING TODAY (CTA Banner)
            ========================================================================= */}
        <section className="landing-cta-banner">
          <div className="cta-banner-inner">
            <div className="cta-left-content">
              <span className="section-index-badge">03 / START DEPLOYING TODAY</span>
              <h2 className="cta-headline">
                You write the code.<br />We handle the deploy.
              </h2>
            </div>

            <div className="cta-right-actions">
              <button
                type="button"
                className="cta-btn-primary"
                onClick={() => navigate("/projects")}
              >
                Launch Console
              </button>
              <button
                type="button"
                className="cta-link-docs"
                onClick={() => scrollToSection("architecture")}
              >
                Read the docs <span>→</span>
              </button>
            </div>
          </div>
        </section>
      </main>

      {/* =========================================================================
          FOOTER
          ========================================================================= */}
      <footer className="landing-footer-block">
        <div className="footer-inner-container">
          <div className="footer-top-row">
            {/* Brand + Mission */}
            <div className="footer-brand-col">
              <div
                className="footer-brand-logo"
                onClick={() => navigate("/")}
                role="button"
                tabIndex={0}
              >
                <BrandLogo size={24} />
              </div>
              <p className="footer-mission-text">
                A lightweight PaaS for container-based applications. Connect your GitHub repository,
                configure your build, and DeployForge handles the rest.
              </p>
              <p className="footer-copy-text">© 2026 DeployForge. All rights reserved.</p>
            </div>

            {/* Links Columns */}
            <div className="footer-nav-groups">
              <div className="footer-col">
                <span className="footer-col-heading">Product</span>
                <ul className="footer-links-list">
                  <li>
                    <button type="button" onClick={() => scrollToSection("features")}>
                      Overview
                    </button>
                  </li>
                  <li>
                    <button type="button" onClick={() => scrollToSection("architecture")}>
                      Architecture
                    </button>
                  </li>
                  <li>
                    <button type="button" onClick={() => scrollToSection("workflow")}>
                      Docs
                    </button>
                  </li>
                </ul>
              </div>

              <div className="footer-col">
                <span className="footer-col-heading">Company</span>
                <ul className="footer-links-list">
                  <li>
                    <button type="button" onClick={() => navigate("/projects")}>
                      About
                    </button>
                  </li>
                  <li>
                    <a
                      href="https://github.com"
                      target="_blank"
                      rel="noreferrer"
                    >
                      GitHub <ExternalLinkIcon size={11} className="ml-1" />
                    </a>
                  </li>
                  <li>
                    <a href="mailto:support@deployforge.dev">
                      Contact
                    </a>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <div className="footer-bottom-bar">
            <div className="legal-links">
              <a href="#privacy">Privacy</a>
              <span className="dot-sep">·</span>
              <a href="#terms">Terms</a>
              <span className="dot-sep">·</span>
              <a href="#status">Status</a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
