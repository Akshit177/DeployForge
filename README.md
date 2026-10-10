# DeployForge

### Code. Deploy. Done.

**DeployForge** is a lightweight Platform as a Service (PaaS) designed to simplify application deployment. It aims to let developers connect their GitHub repositories, configure their applications, and deploy them in isolated environments without manually managing servers.

The project combines backend engineering, operating system internals, database management, containerization, and networking to demonstrate how a simplified deployment platform works under the hood.

> **Project Status:** In Development
> **Estimated Completion:** December 2026

---

## Table of Contents

- [Overview](#overview)
- [Key Features](#key-features)
- [System Architecture](#system-architecture)
- [Technology Stack](#technology-stack)
- [How It Works](#how-it-works)
- [Operating System Concepts](#operating-system-concepts)
- [Database Design](#database-design)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Deployment Lifecycle](#deployment-lifecycle)
- [Roadmap](#roadmap)
- [Learning Objectives](#learning-objectives)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

DeployForge explores the core engineering behind modern deployment platforms such as Render and Vercel, with a focus on understanding how application builds, execution environments, process management, and deployment metadata work together.

The platform is designed around three core components:

- **Deployment Management:** Manage repositories, configurations, deployment requests, statuses, and logs.
- **Execution Engine:** Use Docker and Linux process-management capabilities, with a C++ execution engine for low-level execution control.
- **Infrastructure Management:** Route deployed applications through Nginx and persist deployment information in PostgreSQL.

The objective is to build a functional, educational PaaS prototype while applying practical concepts from Operating Systems, DBMS, Computer Networks, and System Design.

## Key Features

The following features represent the planned scope of the project. Their implementation status may vary.

- **User Authentication:** Account registration, login, and protected resources.
- **Repository Integration:** Connect a GitHub repository as the source of an application.
- **Automated Builds:** Clone source code, install dependencies, and build applications.
- **Isolated Execution:** Run applications inside Docker containers.
- **Deployment Lifecycle Management:** Track deployment states, including queued, building, running, successful, and failed deployments.
- **Logs and Diagnostics:** Store and retrieve build output and execution logs.
- **Resource Monitoring:** Inspect process and container resource usage on Linux.
- **Reverse Proxy:** Route incoming requests to deployed applications through Nginx.
- **Persistent Storage:** Maintain user accounts, repository configurations, deployment history, and logs in PostgreSQL.
- **Process Control:** Explore starting, stopping, and monitoring deployment processes.

## System Architecture

```mermaid
flowchart TD
    A[Developer] --> B[DeployForge Dashboard]
    B --> C[Backend REST API]
    C --> D[Authentication and Authorization]
    C --> E[Deployment Manager]
    D --> F[(PostgreSQL)]
    E --> F
    E --> G[Job Queue / Scheduler]
    G --> H[C++ Execution Engine]
    H --> I[Git Clone and Build]
    I --> J[Docker Container]
    J --> K[Nginx Reverse Proxy]
    K --> L[Deployed Application]
    H --> M[Logs and Resource Metrics]
    M --> F
```

### Architecture Components

| Component            | Responsibility                                                    |
| -------------------- | ----------------------------------------------------------------- |
| Frontend             | Dashboard, authentication, and deployment controls                |
| Backend API          | Request handling, validation, authorization, and business logic   |
| PostgreSQL           | Persistent storage and relational data management                 |
| Deployment Manager   | Coordinates deployment jobs and lifecycle transitions             |
| C++ Execution Engine | Low-level process execution and lifecycle control                 |
| Docker               | Application containerization and isolation                        |
| Nginx                | Reverse proxy and application traffic routing                     |
| Linux                | Process management, signals, filesystems, and resource inspection |

## Technology Stack

| Technology      | Purpose                                          |
| --------------- | ------------------------------------------------ |
| React / Next.js | Frontend dashboard                               |
| Node.js         | Backend runtime                                  |
| Express.js      | REST API development                             |
| PostgreSQL      | Relational database                              |
| C++             | Execution engine and OS-level process management |
| Docker          | Containerization and application execution       |
| Nginx           | Reverse proxy and request routing                |
| Linux           | Process and resource management                  |
| Git and GitHub  | Version control and repository integration       |

## How It Works

A typical deployment is expected to follow this workflow:

1. **Register or log in:** The developer authenticates with DeployForge.
2. **Connect a repository:** The developer supplies a GitHub repository and deployment configuration.
3. **Create a deployment:** The backend validates the request and records a deployment in PostgreSQL.
4. **Fetch the source code:** The deployment worker clones the repository.
5. **Build the application:** Dependencies are installed and the application is built.
6. **Launch the application:** The execution engine coordinates application startup inside a Docker container.
7. **Configure routing:** Nginx routes requests to the appropriate running application.
8. **Track the result:** Deployment status, logs, and relevant metrics are persisted and made available through the dashboard.

## Operating System Concepts

DeployForge is designed to demonstrate how operating system concepts support real-world deployment workflows.

| Concept                     | Application                                                                       |
| --------------------------- | --------------------------------------------------------------------------------- |
| Process creation            | `fork()` for creating processes where appropriate                                 |
| Program execution           | `exec()` family for executing programs                                            |
| Process synchronization     | `waitpid()` for collecting child-process status                                   |
| Signals                     | Graceful termination and process control                                          |
| Inter-process communication | Pipes, sockets, or other IPC mechanisms for communication and log handling        |
| Scheduling                  | Managing deployment jobs and concurrent execution                                 |
| Resource monitoring         | Inspecting CPU and memory information through Linux `/proc` and container metrics |
| Process isolation           | Docker isolation, Linux namespaces, and cgroups                                   |
| Filesystem management       | Managing cloned repositories, build artifacts, and temporary files                |

These concepts will be incorporated progressively as the execution engine and deployment workflow evolve.

## Database Design

PostgreSQL serves as the central persistent data store.

The planned logical data model includes:

- **Users:** Account information and authentication-related metadata.
- **Repositories:** Repository URLs and deployment configuration.
- **Deployments:** Deployment identifiers, statuses, timestamps, and build results.
- **Deployment Logs:** Build output, runtime logs, and diagnostic information.

### Core Relationships

```mermaid
erDiagram
    USERS ||--o{ REPOSITORIES : owns
    REPOSITORIES ||--o{ DEPLOYMENTS : has
    DEPLOYMENTS ||--o{ DEPLOYMENT_LOGS : produces

    USERS {
        uuid id PK
        string email UK
        string password_hash
    }

    REPOSITORIES {
        uuid id PK
        uuid user_id FK
        string repository_url
        jsonb configuration
    }

    DEPLOYMENTS {
        uuid id PK
        uuid repository_id FK
        string status
        timestamp created_at
    }

    DEPLOYMENT_LOGS {
        uuid id PK
        uuid deployment_id FK
        text message
        timestamp created_at
    }
```

This schema is a conceptual starting point and may evolve during implementation.

PostgreSQL is selected for its relational integrity, transactions, indexing, concurrent access support, and JSONB support for flexible deployment configurations.

## Project Structure

The following is a proposed high-level structure; directories will evolve with implementation.

```text
DeployForge/
├── frontend/                 # Web dashboard
├── backend/                  # Node.js and Express API
│   ├── src/
│   │   ├── routes/
│   │   ├── controllers/
│   │   ├── services/
│   │   ├── middleware/
│   │   └── config/
│   └── package.json
├── execution-engine/          # C++ process execution engine
│   ├── src/
│   ├── include/
│   └── CMakeLists.txt
├── database/                  # Schema and migrations
├── infrastructure/
│   ├── docker/
│   └── nginx/
├── docs/                      # Architecture and design documents
├── .env.example
├── .gitignore
└── README.md
```

## Getting Started

### Prerequisites

Install the tools required for the components you intend to run:

- Node.js and npm
- PostgreSQL
- Git
- Docker Engine
- Nginx
- A C++ compiler and CMake
- Linux environment for OS-level execution features

### Installation

**1. Clone the repository**

```bash
git clone <YOUR_REPOSITORY_URL>
cd DeployForge
```

**2. Install backend dependencies**

```bash
cd backend
npm install
```

**3. Configure environment variables**

Create a `.env` file based on `.env.example` and configure the database connection, authentication secrets, and other required settings.

**4. Set up PostgreSQL**

Create a development database and apply the project's database schema or migrations using the configured database tooling.

**5. Start the backend**

```bash
npm run dev
```

**6. Run the frontend and execution engine**

Follow the setup instructions in their respective directories once those components are implemented.

> **Note:** These are initial setup guidelines, not a guarantee that every command is currently runnable. Adjust them to match the actual scripts, migrations, and configuration in the repository.

## Environment Variables

Example configuration for local development:

```env
PORT=5000
NODE_ENV=development

DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/deployforge

JWT_SECRET=replace_with_a_secure_random_secret
JWT_EXPIRES_IN=1d
```

Use strong, unique secrets in local and production environments. Never commit real credentials or `.env` files to version control.

The actual variables depend on the authentication implementation, database tooling, and infrastructure configuration.

## Deployment Lifecycle

A deployment can be modeled as a sequence of explicit states:

```text
QUEUED
   |
   v
BUILDING
   |
   +-------> FAILED
   |
   v
STARTING
   |
   +-------> FAILED
   |
   v
RUNNING
   |
   +-------> STOPPED
```

Each state transition should be validated by the backend and persisted in PostgreSQL. Failures should capture enough diagnostic information to explain why a deployment did not succeed.

## Roadmap

- [ ] **Phase 1 — Backend Foundation:** Authentication, user management, database connectivity, and API structure.
- [ ] **Phase 2 — Repository Management:** Repository registration, deployment configurations, and validation.
- [ ] **Phase 3 — Deployment Pipeline:** Job creation, source cloning, build execution, and status transitions.
- [ ] **Phase 4 — C++ Execution Engine:** Process lifecycle management, execution control, timeouts, and IPC.
- [ ] **Phase 5 — Docker Integration:** Isolated application execution and resource limits.
- [ ] **Phase 6 — Logs and Monitoring:** Persistent logs, deployment diagnostics, and resource metrics.
- [ ] **Phase 7 — Reverse Proxy:** Nginx configuration and routing to deployed applications.
- [ ] **Phase 8 — Dashboard Integration:** Connect the frontend to the complete deployment workflow.
- [ ] **Phase 9 — Testing and Documentation:** Integration tests, security checks, and deployment documentation.

## Learning Objectives

DeployForge is intended to provide hands-on experience with:

- Designing REST APIs and authentication systems.
- Modeling relational data and enforcing database integrity.
- Managing processes and system resources on Linux.
- Understanding containerization and application isolation.
- Implementing concurrent background jobs.
- Working with HTTP routing and reverse proxies.
- Designing modular services and documenting system architecture.
- Applying security principles to application deployment.

## Security Considerations

Security is a core design requirement because deploying user-supplied source code involves executing potentially untrusted applications.

Planned safeguards include:

- Authentication and authorization for deployment operations.
- Secure password hashing and token management.
- Restricted container privileges and resource limits.
- Validation of repository URLs and deployment configuration.
- Isolation of application files and execution environments.
- Protection of internal services and infrastructure endpoints.
- Safe handling of secrets, logs, and error messages.

**Important:** DeployForge is an educational project under development, not a production-ready hosting service. Running untrusted code requires additional security controls, careful isolation, and thorough testing before public exposure.

## Contributing

Contributions, suggestions, and bug reports are welcome.

1. Fork the repository.
2. Create a feature branch.
3. Make your changes and add relevant tests.
4. Submit a pull request describing the changes.

## License

The project's license has not yet been specified. Add a `LICENSE` file and update this section before distributing the project.

---

**DeployForge — Code. Deploy. Done.**

Built to explore the engineering behind modern application deployment platforms.
