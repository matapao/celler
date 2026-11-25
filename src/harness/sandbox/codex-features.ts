// Codex's own features: those every system's settings give it (codex.*.ts), and those of the rest celler lets be on as
// Codex has them, from the version it is made with (limits.ts agentVersions) to the newest it was checked with
// (0.172.0), each by Codex's own description of it.
// Before its first run, and in its health, Codex lists its features as they stand under these settings: each it is
// given must stand as given, and none other be on but those named here. So a feature a newer Codex adds or turns on
// stops its runs until celler is made with it. One Codex lists as removed does nothing, whatever it says.

/** Those it is given: what reaches outside the computer, or beyond what a run may do, off. */
export const CODEX_FEATURES = {
  view_image: false,
  // The local native Windows sandbox, where there is one.
  prefer_mxc: true,
  apps: false,
  plugins: false,
  hooks: false,
  memories: false,
  browser_use: false,
  browser_use_external: false,
  computer_use: false,
  // Goals it sets itself and goes on with after its turn.
  goals: false,
  image_generation: false,
  // MCP servers a skill needs, installed.
  skill_mcp_dependency_install: false,
};

/** Those it may have on as it has them. */
export const CODEX_FEATURES_ON: ReadonlySet<string> = new Set([
  // Its commands, in its sandbox; a model-only decision runs none (codex.ts).
  'shell_tool',
  'unified_exec',
  'unified_exec_tty',
  'shell_snapshot',
  'write_stdin_approval',
  'sleep_tool',
  // Its own JavaScript tool, which calls its other tools.
  'code_mode_host',
  'code_mode_host_grpc',
  'code_mode_host_output_truncation',
  'code_mode_interrupt',
  'instant_interrupt',
  // Its helpers, each with its tools; a model-only decision has none (codex.ts).
  'multi_agent',
  // How it lists its tools to its model.
  'incremental_tools',
  'incremental_tools_legacy',
  'incremental_tools_legacy_gcp',
  'deferred_tool_world_state',
  'prediction_preserve_parent_tools',
  'retain_client_tool_outputs',
  'untrusted_as_tool_output',
  'content_item_kinds',
  // Suggestions of apps' tools, which needs apps and plugins, off; skills searched, of which it has none.
  'tool_suggest',
  'skill_search',
  // Nothing in it yet.
  'workspace_dependencies',
  // How it asks an MCP server's approvals and sign-ins, of which the run's servers ask none; and when it starts a
  // server's program, of which it is given none (on from 0.172.0).
  'tool_call_mcp_elicitation',
  'auth_elicitation',
  'mcp_oauth_refresh_coordination',
  'mcp_lazy_stdio_startup',
  // Its requests to its model service.
  'enable_request_compression',
  'unbounded_connection_retries',
  'system_proxy_fallback',
  'fast_mode',
  'ultrafast_mode',
  'reasoning_effort_override',
  'compaction_image_budget',
  'unified_image_budget',
  'api_key_model_discovery',
  'api_key_cyber_access_programs',
  'cli_daybreak',
  // Its review of what it asks, which it never does: it refuses itself.
  'guardian_approval',
  'guardian_include_additional_context',
  'guardian_reuse_parent_compaction',
  // Its sign-in, kept by Windows' own store there.
  'secret_auth_storage',
  // Its own terminal's and desktop apps', none of which runs here.
  'bedrock_setup_wizard',
  'mentions_v2',
  'tui_workspace',
  'daemon_auto_start',
  'in_app_browser',
  'in_app_chat',
  'in_app_dictation',
  'in_app_local_automation',
  'in_app_updates',
  'in_app_voice',
  'browser_annotation_api',
  'browser_use_full_cdp_access',
  'remote_plugin',
  'plugin_sharing',
]);
