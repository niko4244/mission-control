# MCP Routing Standard

**Version**: 1.0.0
**Date**: 2026-04-27
**Status**: Active

---

## 1. Command Classes

### 1.1 Read-only Commands

Safe commands that do not modify state:

| Command | Description |
|---------|-------------|
| `mc_status` | Get hub status |
| `mc_inspect` | Inspect configuration |
| `mc_list_agents` | List registered agents |
| `mc_list_routes` | List model routes |
| `mc_query_memory` | Query knowledge base |
| `mc_generate_summary` | Generate daily summary |

### 1.2 Controlled Write Commands

Require validation but are generally safe:

| Command | Description | Requirements |
|---------|-------------|--------------|
| `mc_create_task` | Create new task | Valid task title, track |
| `mc_update_task` | Update task status | Valid task ID |
| `mc_write_memory` | Write to knowledge base | Content validated |
| `mc_update_route` | Update model route | YAML must be valid |
| `mc_generate_report` | Generate report | None |

### 1.3 Dangerous Commands

Require explicit approval or protected mode:

| Command | Description | Requirements |
|---------|-------------|--------------|
| `mc_delete_files` | Delete files | Task ID + rollback plan |
| `mc_install_packages` | Install packages | Task ID + reason |
| `mc_modify_secrets` | Modify secrets | Env var only, no hardcode |
| `mc_commit` | Git commit | Diff reviewed |
| `mc_push` | Git push | Branch verified |
| `mc_run_migrations` | Run migrations | Backup required |
| `mc_shell_exec` | Run shell commands | Allowlist only |

---

## 2. Routing Rules

### 2.1 MCP Validation Layer

All execution requests go through MCP validation:

```
Request → MCP Server → Validate → Route → Execute → Log Result
```

### 2.2 Hermes Worker Registration

Direct Hermes execution is allowed only if:
1. Hermes is registered as a Mission Control worker task
2. The task has a valid task_id
3. The command type is classified (read/controlled_write/dangerous)

### 2.3 Tool Call Logging

All tool calls must be logged:
- Timestamp
- Agent ID
- Tool name
- Input parameters (sanitized)
- Output status
- Duration

### 2.4 Dangerous Operation Requirements

All dangerous operations require:
1. **task_id** - Active Mission Control task
2. **reason** - Business justification
3. **affected_path** - Files/paths impacted
4. **rollback_plan** - How to undo if needed
5. **checks_to_run** - Verification commands

---

## 3. Command Classification Logic

### 3.1 Read Classification Criteria
- No file system modifications
- No network calls that mutate state
- No credential or secret exposure
- Pure read operations on DB/memory

### 3.2 Controlled Write Classification Criteria
- Creates/updates records in DB
- Writes to knowledge base
- Modifies configuration files
- Updates agent state

### 3.3 Dangerous Classification Criteria
- Deletes files or records
- Installs packages or dependencies
- Modifies secrets or credentials
- Executes shell commands
- Performs git operations (commit/push)
- Runs migrations or schema changes
- Executes commands outside approved allowlist

---

## 4. Implementation

### 4.1 MCP Server Tools

The MCP server exposes these routing tools:

```typescript
// Classification
'mc_classify_command' - Classifies a command as read/controlled_write/dangerous

// Validation  
'mc_validate_operation' - Validates dangerous operation requirements

// Execution
'mc_execute_if_allowed' - Executes if validation passes
```

### 4.2 Allowlist Files

Shell commands must be in an allowlist:
- `ops/shell-allowlist.json` - Approved commands
- Commands not in allowlist are blocked

---

## 5. Change History

| Date | Change | Author |
|------|--------|--------|
| 2026-04-27 | Initial MCP routing standard | Hub consolidation phase 3 |