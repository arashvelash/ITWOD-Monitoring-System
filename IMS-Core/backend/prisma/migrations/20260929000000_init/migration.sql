-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "ServerType" AS ENUM ('UBUNTU', 'CPANEL');

-- CreateEnum
CREATE TYPE "ServerStatus" AS ENUM ('PENDING', 'ONLINE', 'OFFLINE', 'REVOKED', 'DECOMMISSIONED');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('PENDING', 'SENT', 'ACKNOWLEDGED', 'SUCCEEDED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CommandOrigin" AS ENUM ('DASHBOARD', 'TELEGRAM', 'SYSTEM');

-- CreateEnum
CREATE TYPE "BackupType" AS ENUM ('FILES', 'MYSQL', 'POSTGRES');

-- CreateEnum
CREATE TYPE "BackupDestinationType" AS ENUM ('LOCAL', 'S3');

-- CreateEnum
CREATE TYPE "BackupRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "BackupTrigger" AS ENUM ('SCHEDULED', 'MANUAL', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('NODE_OFFLINE', 'CPU_HIGH', 'MEMORY_HIGH', 'DISK_HIGH', 'SERVICE_DOWN', 'BACKUP_FAILED', 'BACKUP_MISSED', 'AGENT_UPDATE_FAILED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'NODE', 'SYSTEM', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "ReleaseSource" AS ENUM ('GITHUB', 'UPLOAD');

-- CreateEnum
CREATE TYPE "CoreUpdateStatus" AS ENUM ('REQUESTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "email" VARCHAR(255),
    "display_name" VARCHAR(128),
    "password_hash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'VIEWER',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "must_change_password" BOOLEAN NOT NULL DEFAULT false,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),
    "last_login_ip" VARCHAR(64),
    "password_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "user_agent" VARCHAR(512),
    "ip_address" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absolute_expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" VARCHAR(64),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "servers" (
    "id" UUID NOT NULL,
    "serial" SERIAL NOT NULL,
    "node_id" VARCHAR(48) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "type" "ServerType" NOT NULL,
    "operating_system" VARCHAR(128) NOT NULL,
    "description" VARCHAR(1000),
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ServerStatus" NOT NULL DEFAULT 'PENDING',
    "hostname" VARCHAR(255),
    "ip_address" VARCHAR(64),
    "os_details" VARCHAR(255),
    "arch" VARCHAR(32),
    "agent_version" VARCHAR(32),
    "registered_at" TIMESTAMP(3),
    "last_heartbeat_at" TIMESTAMP(3),
    "last_metrics_at" TIMESTAMP(3),
    "latest_metrics" JSONB,
    "monitoring_config" JSONB,
    "config_version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_credentials" (
    "id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "secret_encrypted" TEXT NOT NULL,
    "public_key" VARCHAR(64),
    "key_fingerprint" VARCHAR(80),
    "key_algorithm" VARCHAR(16),
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "node_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_tokens" (
    "id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "token_prefix" VARCHAR(16) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "used_by_ip" VARCHAR(64),
    "revoked_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registration_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_commands" (
    "id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "CommandStatus" NOT NULL DEFAULT 'PENDING',
    "origin" "CommandOrigin" NOT NULL DEFAULT 'DASHBOARD',
    "created_by_id" UUID,
    "delivery_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "acknowledged_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "result" JSONB,
    "error_message" VARCHAR(2000),

    CONSTRAINT "node_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "slug" VARCHAR(96) NOT NULL,
    "description" VARCHAR(2000),
    "website_url" VARCHAR(512),
    "server_id" UUID,
    "archived_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_jobs" (
    "id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "project_id" UUID,
    "server_id" UUID NOT NULL,
    "type" "BackupType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "schedule" VARCHAR(64) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'UTC',
    "source_config" JSONB NOT NULL,
    "source_secrets_encrypted" TEXT,
    "destination_type" "BackupDestinationType" NOT NULL DEFAULT 'LOCAL',
    "destination_config" JSONB NOT NULL DEFAULT '{}',
    "destination_secrets_encrypted" TEXT,
    "retention_count" INTEGER NOT NULL DEFAULT 7,
    "retention_days" INTEGER,
    "encryption_enabled" BOOLEAN NOT NULL DEFAULT false,
    "encryption_key_encrypted" TEXT,
    "compression_level" INTEGER NOT NULL DEFAULT 6,
    "timeout_minutes" INTEGER NOT NULL DEFAULT 120,
    "last_run_at" TIMESTAMP(3),
    "last_run_status" "BackupRunStatus",
    "last_success_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "created_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backup_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_runs" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "trigger" "BackupTrigger" NOT NULL,
    "status" "BackupRunStatus" NOT NULL DEFAULT 'QUEUED',
    "command_id" UUID,
    "requested_by_id" UUID,
    "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "size_bytes" BIGINT,
    "checksum_sha256" CHAR(64),
    "file_name" VARCHAR(255),
    "location" VARCHAR(1024),
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "error_message" VARCHAR(2000),
    "log_tail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backup_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_metrics" (
    "id" BIGSERIAL NOT NULL,
    "server_id" UUID NOT NULL,
    "collected_at" TIMESTAMP(3) NOT NULL,
    "cpu_percent" REAL,
    "load1" REAL,
    "load5" REAL,
    "load15" REAL,
    "mem_total_bytes" BIGINT,
    "mem_used_bytes" BIGINT,
    "swap_total_bytes" BIGINT,
    "swap_used_bytes" BIGINT,
    "disk_used_percent" REAL,
    "disks" JSONB,
    "net_rx_bps" DOUBLE PRECISION,
    "net_tx_bps" DOUBLE PRECISION,
    "uptime_sec" INTEGER,

    CONSTRAINT "node_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "fingerprint" VARCHAR(255) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "message" VARCHAR(2000) NOT NULL,
    "details" JSONB,
    "server_id" UUID,
    "job_id" UUID,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledged_at" TIMESTAMP(3),
    "acknowledged_by_id" UUID,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_links" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "chat_id" BIGINT NOT NULL,
    "telegram_user_id" BIGINT NOT NULL,
    "telegram_username" VARCHAR(64),
    "notifications_enabled" BOOLEAN NOT NULL DEFAULT true,
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_command_at" TIMESTAMP(3),

    CONSTRAINT "telegram_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telegram_link_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_link_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor_type" "AuditActorType" NOT NULL,
    "actor_id" VARCHAR(64),
    "actor_name" VARCHAR(128),
    "action" VARCHAR(96) NOT NULL,
    "target_type" VARCHAR(64),
    "target_id" VARCHAR(64),
    "success" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" VARCHAR(128) NOT NULL,
    "value" JSONB,
    "secret_encrypted" TEXT,
    "updated_by_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "agent_releases" (
    "id" UUID NOT NULL,
    "version" VARCHAR(32) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "signature" VARCHAR(128),
    "size_bytes" BIGINT NOT NULL,
    "source" "ReleaseSource" NOT NULL,
    "storage_path" VARCHAR(1024) NOT NULL,
    "release_notes" TEXT,
    "published_at" TIMESTAMP(3),
    "is_revoked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_releases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "core_updates" (
    "id" UUID NOT NULL,
    "from_version" VARCHAR(32) NOT NULL,
    "to_version" VARCHAR(32) NOT NULL,
    "status" "CoreUpdateStatus" NOT NULL DEFAULT 'REQUESTED',
    "current_step" VARCHAR(64),
    "requested_by_id" UUID,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "log" TEXT,
    "error_message" VARCHAR(2000),

    CONSTRAINT "core_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "servers_serial_key" ON "servers"("serial");

-- CreateIndex
CREATE UNIQUE INDEX "servers_node_id_key" ON "servers"("node_id");

-- CreateIndex
CREATE INDEX "servers_status_idx" ON "servers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "node_credentials_server_id_key" ON "node_credentials"("server_id");

-- CreateIndex
CREATE UNIQUE INDEX "registration_tokens_token_hash_key" ON "registration_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "registration_tokens_server_id_idx" ON "registration_tokens"("server_id");

-- CreateIndex
CREATE INDEX "node_commands_server_id_status_idx" ON "node_commands"("server_id", "status");

-- CreateIndex
CREATE INDEX "node_commands_expires_at_idx" ON "node_commands"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "projects_slug_key" ON "projects"("slug");

-- CreateIndex
CREATE INDEX "backup_jobs_server_id_idx" ON "backup_jobs"("server_id");

-- CreateIndex
CREATE UNIQUE INDEX "backup_jobs_server_id_slug_key" ON "backup_jobs"("server_id", "slug");

-- CreateIndex
CREATE INDEX "backup_runs_job_id_created_at_idx" ON "backup_runs"("job_id", "created_at");

-- CreateIndex
CREATE INDEX "backup_runs_server_id_created_at_idx" ON "backup_runs"("server_id", "created_at");

-- CreateIndex
CREATE INDEX "backup_runs_status_idx" ON "backup_runs"("status");

-- CreateIndex
CREATE INDEX "node_metrics_server_id_collected_at_idx" ON "node_metrics"("server_id", "collected_at");

-- CreateIndex
CREATE INDEX "node_metrics_collected_at_idx" ON "node_metrics"("collected_at");

-- CreateIndex
CREATE INDEX "alerts_status_idx" ON "alerts"("status");

-- CreateIndex
CREATE INDEX "alerts_fingerprint_status_idx" ON "alerts"("fingerprint", "status");

-- CreateIndex
CREATE INDEX "alerts_server_id_idx" ON "alerts"("server_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_links_chat_id_key" ON "telegram_links"("chat_id");

-- CreateIndex
CREATE INDEX "telegram_links_user_id_idx" ON "telegram_links"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "telegram_link_codes_code_hash_key" ON "telegram_link_codes"("code_hash");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_target_type_target_id_idx" ON "audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_releases_version_key" ON "agent_releases"("version");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_credentials" ADD CONSTRAINT "node_credentials_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_tokens" ADD CONSTRAINT "registration_tokens_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_commands" ADD CONSTRAINT "node_commands_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "backup_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_metrics" ADD CONSTRAINT "node_metrics_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "backup_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telegram_link_codes" ADD CONSTRAINT "telegram_link_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

