# mcp-server-for-revit

MCP server for interacting with Autodesk Revit through AI assistants like Claude.

This package is the MCP server component of [mcp-servers-for-revit](https://github.com/mcp-servers-for-revit/mcp-servers-for-revit). It exposes Revit operations as MCP tools that AI clients can call. The server communicates with the [Revit plugin](https://github.com/mcp-servers-for-revit/mcp-servers-for-revit) over WebSocket to execute commands inside Revit.

> [!NOTE]
> This server requires the mcp-servers-for-revit Revit plugin to be installed and running inside Revit. See the [full project README](https://github.com/mcp-servers-for-revit/mcp-servers-for-revit) for setup instructions.

## Setup

**Claude Code**

```bash
claude mcp add mcp-server-for-revit -- npx -y mcp-server-for-revit
```

**Claude Desktop**

Claude Desktop → Settings → Developer → Edit Config → `claude_desktop_config.json`:

```json
{
    "mcpServers": {
        "mcp-server-for-revit": {
            "command": "npx",
            "args": ["-y", "mcp-server-for-revit"]
        }
    }
}
```

Restart Claude Desktop. When you see the hammer icon, the MCP server is connected.

## Supported Tools

Prefer dedicated tools before `send_code_to_revit`. Lengths and sizes are millimeters unless noted. Full descriptions live in the [project README](https://github.com/jesselei1102-hue/Revit-MCP-Server-Apps#mcp-tools).

### Query & inspect

| Tool | Description |
| ---- | ----------- |
| `query_model` | Multi-criteria element query → Ids + analysis |
| `get_element_data` | Element info / parameters |
| `ai_element_filter` | Category / type / visibility / spatial filter |
| `get_current_view_info` | Active view details |
| `get_current_view_elements` | Elements in the active view |
| `get_selected_elements` | Current selection |
| `get_available_family_types` | Loaded family types |
| `analyze_model_statistics` | Model composition counts |
| `get_material_quantities` | Material takeoff |
| `export_room_data` | Room data export |
| `get_running_revit_instances` | Running Revit processes / documents |

### Navigate, create, edit

| Tool | Description |
| ---- | ----------- |
| `select_elements` / `zoom_to_elements` / `open_view` / `export_views` / `color_elements` | Navigate and export |
| `create_grid` / `create_level` / `create_room` / `create_dimensions` | Grids, levels, rooms, dims |
| `create_point_based_element` / `create_line_based_element` / `create_surface_based_element` | Place elements |
| `create_structural_framing_system` | Beam system |
| `operate_element` | Select / Hide / Delete / SetColor / Highlight / Isolate / ResetOverride / ChangeType / SetParameter |
| `delete_element` | Delete by Id |
| `tag_all_rooms` / `tag_all_walls` | Tag rooms or walls in the active view |

### MEP (pipes, ducts, cable trays)

| Tool | Description |
| ---- | ----------- |
| `get_pipe_types` / `get_duct_types` / `get_cable_tray_types` | List types |
| `get_pipe_system_types` / `get_duct_system_types` | List system types |
| `get_pipes` / `get_ducts` / `get_cable_trays` | List instances |
| `create_pipe` / `create_duct` / `create_cable_tray` | Straight runs |
| `modify_pipe` / `modify_duct` / `modify_cable_tray` | Move / resize / retype |
| `create_mep_fitting` and `create_*_fitting` | Elbow, transition, union, tee, cross, takeoff |

Requires the Revit add-in **v1.1.0+** with `RevitMCPMEPCommandSet` installed.

### Checks, Apps, storage

| Tool | Description |
| ---- | ----------- |
| `rules_import_checkset` / `rules_upsert` / `rules_list` / `rules_set_enabled` | Manage check rules |
| `checks_run` / `checks_get_results` | Run checks and read results |
| `mcp_apps_get_schedule_data` | Schedule UI (Elements / Checks) |
| `store_project_data` / `store_room_data` / `query_stored_data` | Local SQLite store |
| `say_hello` | Connection smoke test |
| `send_code_to_revit` | **Last resort** C# when no dedicated tool fits |

## Development

```bash
npm install
npm run build
```

To try the Schedule window without Claude, Cursor or Revit, serve this folder after a build
(`python -m http.server 8791 --bind 127.0.0.1`) and open `http://localhost:8791/mcp-app/dev/harness.html`.
The mock host fills the window with made-up rows, rule sets and check results, and answers every write tool with a
stub, so nothing reaches Revit. URL parameters: `theme=dark`, `checks=none|running|failed|done`, `slowrules=1`,
`applyfail=1` (the second write fails, so an Apply stops part-way).

## License

[MIT](https://github.com/mcp-servers-for-revit/mcp-servers-for-revit/blob/main/LICENSE)
