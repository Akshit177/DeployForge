-- DeployForge PostgreSQL Database Schema
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table (reference definition)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    github_connected BOOLEAN DEFAULT false NOT NULL,
    notification_preferences JSONB DEFAULT '{"notify_failures": true, "notify_weekly": false}'::jsonb NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    repository_url TEXT NOT NULL,
    branch VARCHAR(100) DEFAULT 'main' NOT NULL,
    runtime VARCHAR(50) DEFAULT 'node' NOT NULL,
    port INTEGER DEFAULT 3000 NOT NULL,
    auto_deploy BOOLEAN DEFAULT true NOT NULL,
    env_vars JSONB DEFAULT '[]'::jsonb NOT NULL,
    status VARCHAR(50) DEFAULT 'Queued' NOT NULL,
    domain VARCHAR(255),
    latest_commit VARCHAR(40) DEFAULT 'HEAD',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_user_project_name UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_created_at ON projects(created_at DESC);

-- Deployments table
CREATE TABLE IF NOT EXISTS deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_number SERIAL,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    commit_hash VARCHAR(40) DEFAULT 'HEAD' NOT NULL,
    commit_message TEXT DEFAULT 'Deploy latest changes' NOT NULL,
    branch VARCHAR(100) DEFAULT 'main' NOT NULL,
    status VARCHAR(50) DEFAULT 'Queued' NOT NULL,
    trigger VARCHAR(50) DEFAULT 'manual' NOT NULL,
    environment VARCHAR(50) DEFAULT 'production' NOT NULL,
    url VARCHAR(255),
    duration_seconds INTEGER DEFAULT 0 NOT NULL,
    container_id VARCHAR(128),
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deployments_project_id ON deployments(project_id);
CREATE INDEX IF NOT EXISTS idx_deployments_user_id ON deployments(user_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
CREATE INDEX IF NOT EXISTS idx_deployments_created_at ON deployments(created_at DESC);

-- Logs table
CREATE TABLE IF NOT EXISTS logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    level VARCHAR(20) DEFAULT 'INFO' NOT NULL,
    source VARCHAR(50) DEFAULT 'build' NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_logs_deployment_id ON logs(deployment_id);
CREATE INDEX IF NOT EXISTS idx_logs_project_id ON logs(project_id);
CREATE INDEX IF NOT EXISTS idx_logs_user_id ON logs(user_id);
CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at DESC);

-- Project Environment Variables (Encrypted Secrets Vault)
CREATE TABLE IF NOT EXISTS project_env_vars (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    encrypted_value TEXT NOT NULL,
    iv VARCHAR(64) NOT NULL,
    auth_tag VARCHAR(64) NOT NULL,
    is_secret BOOLEAN DEFAULT false NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_project_env_key UNIQUE (project_id, key)
);

CREATE INDEX IF NOT EXISTS idx_env_project_id ON project_env_vars(project_id);
CREATE INDEX IF NOT EXISTS idx_env_user_id ON project_env_vars(user_id);

-- Custom Domains table
CREATE TABLE IF NOT EXISTS custom_domains (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    domain VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'Active' NOT NULL,
    is_default BOOLEAN DEFAULT false NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    CONSTRAINT uq_custom_domain UNIQUE (domain)
);

CREATE INDEX IF NOT EXISTS idx_domains_user_id ON custom_domains(user_id);
CREATE INDEX IF NOT EXISTS idx_domains_project_id ON custom_domains(project_id);
