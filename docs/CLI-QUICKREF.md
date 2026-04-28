Mission Control CLI

Usage:
  mc memory status                      Show memory status
  mc memory sync --dry-run             Scan memory sources (no changes)
  mc memory sync --apply                Sync memory to MC DB
  mc memory query "<term>"              Search memory

  mc agents run hermes --task <id> "p"  Execute with task guard
  mc task create "title"               Create task
  mc task list                         List tasks
  mc task status <id>                  Get task

Examples:
  mc memory status
  mc memory sync --dry-run
  mc memory sync --apply
  mc memory query "hermes"
  
  mc task create "Cleanup logs"
  mc task list
  mc agents run hermes --task 1 "analyze"