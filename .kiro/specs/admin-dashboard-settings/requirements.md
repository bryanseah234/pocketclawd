# Requirements Document

## Introduction

This feature adds a Settings panel to the NanoClaw cloud admin dashboard, enabling administrators to view, edit, validate, and persist system configuration parameters without redeploying. Configuration is stored in AWS Secrets Manager (`nanoclaw/app-config`) and changes are audited to CloudWatch. The panel integrates with the existing admin dashboard at `/admin` (port 3000, HTTP Basic Auth).

## Glossary

- **Admin_Dashboard**: The existing web UI served at `/admin` on port 3000, protected by HTTP Basic Auth with rate limiting
- **Settings_Panel**: A new tab/section within the Admin_Dashboard for viewing and editing system configuration
- **Settings_API**: The REST API endpoints under `/admin/api/settings` that serve and persist configuration
- **Secrets_Manager**: AWS Secrets Manager service storing the `nanoclaw/app-config` secret
- **Orchestrator**: The NanoClaw cloud orchestrator service that coordinates container lifecycle and message processing
- **Validator**: The client-side and server-side validation logic that enforces constraints on configuration values
- **Audit_Logger**: The component responsible for logging settings changes to AWS CloudWatch Logs
- **Change_History_View**: The UI component within the Settings_Panel that displays past settings modifications

## Requirements

### Requirement 1: Settings Panel Display

**User Story:** As an administrator, I want to view current system configuration values in the admin dashboard, so that I can understand the active settings without inspecting AWS directly.

#### Acceptance Criteria

1. WHEN the administrator navigates to the Settings_Panel, THE Admin_Dashboard SHALL display a "Settings" tab accessible from the main navigation
2. WHEN the Settings_Panel loads, THE Settings_API SHALL retrieve current configuration values from Secrets_Manager and return them to the Admin_Dashboard
3. THE Settings_Panel SHALL display the following editable parameters with their current values: chunk size, chunk overlap, embedding model ID, LLM model ID, LLM temperature, LLM max tokens, rate limit per user per minute, rate limit global per hour, notification time, notification timezone, container memory limit, container idle timeout, and minimum similarity threshold
4. THE Settings_Panel SHALL display the default value alongside each parameter: chunk size (512 tokens), chunk overlap (50 tokens), embedding model ID (amazon.titan-embed-text-v2:0), LLM model ID (anthropic.claude-3-5-sonnet-20241022-v2:0), LLM temperature (0.5), LLM max tokens (4096), rate limit per user per minute (20), rate limit global per hour (200), notification time (09:00), notification timezone (Asia/Singapore), container memory limit (512m), container idle timeout (10 min), minimum similarity threshold (0.7)

### Requirement 2: Settings Validation

**User Story:** As an administrator, I want immediate feedback when I enter invalid configuration values, so that I can correct mistakes before saving.

#### Acceptance Criteria

1. WHEN the administrator enters a chunk size value outside the range 128 to 2048, THE Validator SHALL display an inline error message indicating the valid range
2. WHEN the administrator enters a chunk overlap value greater than or equal to the current chunk size value, THE Validator SHALL display an inline error message indicating that overlap must be less than chunk size
3. WHEN the administrator enters a non-positive-integer value for rate limit per user per minute or rate limit global per hour, THE Validator SHALL display an inline error message indicating that rate limits must be positive integers
4. WHEN the administrator enters a temperature value outside the range 0.0 to 1.0, THE Validator SHALL display an inline error message indicating the valid range
5. WHEN the administrator enters a memory limit value that does not match a valid Docker memory string pattern (e.g., 256m, 512m, 1g, 2g), THE Validator SHALL display an inline error message indicating the expected format
6. WHEN the administrator submits settings with validation errors, THE Settings_Panel SHALL prevent the save operation and highlight all invalid fields
7. WHEN the Settings_API receives a PUT request with invalid values, THE Settings_API SHALL return a 400 response with field-level error descriptions

### Requirement 3: Save Settings

**User Story:** As an administrator, I want to save configuration changes to persistent storage, so that updated values survive service restarts.

#### Acceptance Criteria

1. WHEN the administrator clicks the "Save" button with valid settings, THE Settings_API SHALL persist the updated values to the `nanoclaw/app-config` secret in Secrets_Manager
2. WHEN the Settings_API successfully persists changes, THE Settings_Panel SHALL display a success confirmation message
3. IF the Settings_API fails to persist changes to Secrets_Manager, THEN THE Settings_API SHALL return an error response and THE Settings_Panel SHALL display the error to the administrator
4. WHEN settings are saved successfully, THE Orchestrator SHALL apply the new values on the next message processing cycle without requiring a restart

### Requirement 4: Apply and Restart

**User Story:** As an administrator, I want to save settings and trigger a graceful restart, so that changes requiring a restart take effect immediately.

#### Acceptance Criteria

1. WHEN the administrator clicks the "Apply & Restart" button with valid settings, THE Settings_API SHALL persist the updated values to Secrets_Manager and trigger a graceful restart of the Orchestrator
2. WHILE the administrator is editing settings that require a container restart (container memory limit), THE Settings_Panel SHALL display a warning indicating that a restart is required for the change to take effect
3. WHEN the Orchestrator receives a restart signal, THE Orchestrator SHALL complete in-progress message processing before restarting
4. IF the restart signal fails to reach the Orchestrator, THEN THE Settings_API SHALL return an error response indicating the restart could not be triggered

### Requirement 5: Settings REST API

**User Story:** As a developer, I want well-defined API endpoints for settings management, so that the dashboard and future integrations can programmatically manage configuration.

#### Acceptance Criteria

1. WHEN an authenticated GET request is made to `/admin/api/settings`, THE Settings_API SHALL return the current configuration values as a JSON object with a 200 status code
2. WHEN an authenticated PUT request is made to `/admin/api/settings` with a valid JSON body, THE Settings_API SHALL validate the payload, persist changes to Secrets_Manager, and return the updated configuration with a 200 status code
3. WHEN an authenticated POST request is made to `/admin/api/settings/apply`, THE Settings_API SHALL persist current settings to Secrets_Manager, trigger a graceful Orchestrator restart, and return a 200 status code with a confirmation message
4. WHEN an unauthenticated request is made to any Settings_API endpoint, THE Settings_API SHALL return a 401 response
5. WHEN a request with invalid JSON is made to PUT `/admin/api/settings`, THE Settings_API SHALL return a 400 response with a descriptive error message

### Requirement 6: Audit Logging

**User Story:** As an administrator, I want all settings changes to be logged with full context, so that I can trace who changed what and when for compliance and debugging.

#### Acceptance Criteria

1. WHEN settings are successfully saved via the Settings_API, THE Audit_Logger SHALL write a log entry to CloudWatch containing the admin username, timestamp, changed field names, old values, and new values
2. THE Audit_Logger SHALL log only the fields that were modified, not the entire configuration payload
3. IF the Audit_Logger fails to write to CloudWatch, THEN THE Settings_API SHALL still complete the save operation and log the audit failure locally

### Requirement 7: Change History View

**User Story:** As an administrator, I want to view a history of settings changes in the dashboard, so that I can review past modifications without accessing CloudWatch directly.

#### Acceptance Criteria

1. WHEN the administrator navigates to the Change_History_View, THE Settings_Panel SHALL display a chronological list of past settings changes
2. THE Change_History_View SHALL display for each entry: the admin username, timestamp, changed field names, old values, and new values
3. WHEN the Change_History_View loads, THE Settings_API SHALL retrieve audit log entries from CloudWatch Logs and return them in reverse chronological order
