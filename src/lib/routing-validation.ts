/**
 * MCP Routing Validation Layer
 * Validates commands before execution
 * 
 * Version: 1.0.0
 * Date: 2026-04-27
 */

export type CommandClass = 'read' | 'controlled_write' | 'dangerous';

// ============================================================================
// COMMAND CLASSIFICATIONS
// ============================================================================

const COMMAND_CLASSES: Record<string, CommandClass> = {
  // Read-only commands
  'mc_status': 'read',
  'mc_inspect': 'read',
  'mc_list_agents': 'read',
  'mc_list_routes': 'read',
  'mc_query_memory': 'read',
  'mc_generate_summary': 'read',
  'memory_query': 'read',
  'memory_status': 'read',
  'agent_list': 'read',
  'task_list': 'read',
  'risk_list': 'read',
  
  // Controlled write commands
  'mc_create_task': 'controlled_write',
  'mc_update_task': 'controlled_write',
  'mc_write_memory': 'controlled_write',
  'mc_update_route': 'controlled_write',
  'mc_generate_report': 'controlled_write',
  'memory_write': 'controlled_write',
  'agent_register': 'controlled_write',
  'task_create': 'controlled_write',
  'task_update': 'controlled_write',
  'check_record': 'controlled_write',
  'risk_record': 'controlled_write',
  
  // Dangerous commands
  'mc_delete_files': 'dangerous',
  'mc_install_packages': 'dangerous',
  'mc_modify_secrets': 'dangerous',
  'mc_commit': 'dangerous',
  'mc_push': 'dangerous',
  'mc_run_migrations': 'dangerous',
  'mc_shell_exec': 'dangerous',
  'git_recordEvent': 'dangerous',
};

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

export function classifyCommand(commandName: string): CommandClass {
  return COMMAND_CLASSES[commandName] || 'dangerous';
}

export interface DangerousOperationRequirements {
  task_id: string;
  reason: string;
  affected_path: string;
  rollback_plan: string;
  checks_to_run?: string[];
}

export interface ValidationResult {
  allowed: boolean;
  command_class: CommandClass;
  requirements_met?: boolean;
  missing_requirements?: string[];
  error?: string;
}

export function validateDangerousOperation(
  operation: DangerousOperationRequirements
): ValidationResult {
  const missing: string[] = [];
  
  if (!operation.task_id) missing.push('task_id');
  if (!operation.reason) missing.push('reason');
  if (!operation.affected_path) missing.push('affected_path');
  if (!operation.rollback_plan) missing.push('rollback_plan');
  
  return {
    allowed: missing.length === 0,
    command_class: 'dangerous',
    requirements_met: missing.length === 0,
    missing_requirements: missing.length > 0 ? missing : undefined,
  };
}

export function validateOperation(
  commandName: string,
  options?: {
    taskId?: string;
    reason?: string;
    affectedPath?: string;
    rollbackPlan?: string;
  }
): ValidationResult {
  if (!Object.prototype.hasOwnProperty.call(COMMAND_CLASSES, commandName)) {
    return {
      allowed: false,
      command_class: 'dangerous',
      requirements_met: false,
      error: `Unknown command: ${commandName}`,
    };
  }

  const commandClass = classifyCommand(commandName);
  
  // Read operations are always allowed
  if (commandClass === 'read') {
    return { allowed: true, command_class: 'read' };
  }
  
  // Controlled write operations need minimal validation
  if (commandClass === 'controlled_write') {
    return { allowed: true, command_class: 'controlled_write' };
  }
  
  // Dangerous operations need full validation
  if (commandClass === 'dangerous') {
    if (!options?.taskId || !options?.reason || !options?.affectedPath || !options?.rollbackPlan) {
      return {
        allowed: false,
        command_class: 'dangerous',
        requirements_met: false,
        missing_requirements: [
          !options?.taskId ? 'task_id' : null,
          !options?.reason ? 'reason' : null,
          !options?.affectedPath ? 'affected_path' : null,
          !options?.rollbackPlan ? 'rollback_plan' : null,
        ].filter(Boolean) as string[],
      };
    }
    
    return {
      allowed: true,
      command_class: 'dangerous',
      requirements_met: true,
    };
  }
  
  // Unknown command - default to controlled
  return {
    allowed: true,
    command_class: 'controlled_write' as CommandClass,
  };
}

// ============================================================================
// OPERATION LOGGING
// ============================================================================

export interface OperationLogEntry {
  timestamp: number;
  agent_id: string;
  command_name: string;
  input_parameters: Record<string, unknown>;
  output_status: 'success' | 'failed' | 'blocked';
  duration_ms?: number;
  command_class: CommandClass;
}

export const operationLog: OperationLogEntry[] = [];

export function logOperation(entry: Omit<OperationLogEntry, 'timestamp'>): void {
  operationLog.push({
    ...entry,
    timestamp: Date.now(),
  });
}

// ============================================================================
// ALLOWLIST FOR SHELL COMMANDS
// ============================================================================

export const SHELL_ALLOWLIST = [
  'git status',
  'git diff',
  'git log',
  'git branch',
  'pnpm install',
  'pnpm build',
  'pnpm test',
  'pnpm lint',
  'pnpm typecheck',
];

export function isShellCommandAllowed(command: string): boolean {
  const normalizedCommand = command.trim();

  if (!normalizedCommand) {
    return false;
  }

  // Block command chaining, redirection, and multiline shell payloads.
  if (/(?:&&|\|\||[|;><`]|[\r\n])/.test(normalizedCommand)) {
    return false;
  }

  const [firstToken = '', secondToken = ''] = normalizedCommand.split(/\s+/, 3);
  const baseCommand = [firstToken, secondToken].filter(Boolean).join(' ').toLowerCase();

  return SHELL_ALLOWLIST.some(allowed => allowed.toLowerCase() === baseCommand);
}
