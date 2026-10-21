


https://github.com/user-attachments/assets/71c89c47-0042-4bf9-acdb-9932ade8c099



# Revit MCP Server Apps

Based on [mcp-servers-for-revit](https://github.com/mcp-servers-for-revit/mcp-servers-for-revit).

This fork keeps the original Revit MCP bridge (server + plugin + command set) and adds **MCP Apps UI**, **Revit 2027** support, and a set of new tools focused on querying, navigating, and editing the model from Cursor / other MCP clients.

The Schedule App is designed as a **HITL (human-in-the-loop) workflow**: the AI opens and loads the model data; **you** review, filter, edit, and confirm before writes go back to Revit.

## What’s new in this fork

### MCP Apps · Schedule (`mcp_apps_get_schedule_data`)

Interactive schedule UI mounted as an MCP App:

- Loads host (+ linked) model instances into a filterable table
- Shows **editable instance parameters** (skips calculated quantities like Area / Volume)
- **Parameters** multi-select next to Link — search and choose which columns to show
- Click a cell for a clear selection border; drag the fill handle to paint values down a column
- Double-click to edit → **Apply parameters** writes back via `SetParameter`
- Type column still supports ChangeType + fill + **Apply types**
- Select / Isolate / zoom helpers for filtered rows

### Why MCP Apps (vs plain Read / Write tools)

MCP Apps and normal MCP tools solve different jobs. Use both. The Schedule App is explicitly a **HITL** path: AI assists with loading/context; humans stay in control of review and apply.

| | **MCP Apps** (Schedule UI, HITL) | **Read / Write tools** (`query_model`, `operate_element`, …) |
|---|---|---|
| Who drives | **You** — click, filter, edit, drag-fill, then Apply | **The AI** — call tools from chat |
| Workflow | Human-in-the-loop: inspect → edit → confirm | Agent-driven: prompt → tool → result |
| Best for | Scan a table, pick columns, tweak many instance params | Automation: “set all door Marks…”, scripted workflows |
| Feedback | Live table in the client | JSON / text back in the conversation |

**Tokens**

- App: load the schedule once into the UI; filtering, column picks, and cell edits stay in the frontend — they do **not** re-enter the model context on every click.
- Tools-only: large tables often get pasted into chat; each “read → decide → write” loop burns another round of input/output tokens.

For “look at the list and fix parameters,” an App usually uses **far fewer conversation tokens** than asking the model to re-read and rewrite rows in chat.

**Efficiency**

- App: Excel-like — fast for human review and batch tweaks after one open.
- Tools: fewer wall-clock seconds for fully automatic, rule-clear jobs; slower when a person must describe every small edit in natural language.

**Rule of thumb:** HITL table work → MCP Apps; hands-off automation → tools. Opening the Schedule App (HITL) then letting tools handle scripted follow-ups is a good combo.

### Revit 2027

- Plugin + command set build configs for **R27 / Revit 2027** (alongside existing 2020–2026)
- Deploy layout under `%AppData%\Autodesk\Revit\Addins\2027\...`

### New / extended tools

| Tool | Description |
| ---- | ----------- |
| `mcp_apps_get_schedule_data` | MCP Apps schedule report (editable params UI) |
| `query_model` | Multi-criteria element query (returns Ids + analysis) |
| `get_element_data` | Element info + parameter modes including `EditableInstanceParameters` |
| `select_elements` | Select elements by Id |
| `zoom_to_elements` | Zoom to elements |
| `open_view` | Open a view by Id |
| `export_views` | Export views |
| `get_running_revit_instances` | List running Revit processes / open documents |
| `operate_element` | Extended with `ChangeType` and `SetParameter` |

Existing upstream tools (create / tag / color / room export / etc.) remain available.

## Requirements

- **Node.js 20+** (MCP server)
- **Autodesk Revit 2020–2027**
- An MCP client that supports **MCP Apps** (e.g. Cursor) for the schedule UI

## Quick start (local)

### 1. Build the MCP server

```bash
cd server
npm install
npm run build
```

Point your client at `server/build/index.js`, for example Cursor `mcp.json`:

```json
{
  "mcpServers": {
    "mcp-server-for-revit": {
      "command": "node",
      "args": ["C:/path/to/Revit-MCP-Server-Apps/server/build/index.js"]
    }
  }
}
```

### 2. Build & install plugin + command set

```bash
# Revit 2027
dotnet build commandset/RevitMCPCommandSet.csproj -c "Debug R27"
dotnet build plugin/RevitMCPPlugin.csproj -c "Debug R27"

# Revit 2026
dotnet build commandset/RevitMCPCommandSet.csproj -c "Debug R26"
```

Debug builds copy into:

```
%AppData%\Autodesk\Revit\Addins\<year>\revit_mcp_plugin\
```

Then open Revit → ribbon **MCP On** → call `mcp_apps_get_schedule_data` from the client.

## Project layout

```
├── server/           # MCP server + MCP Apps (schedule UI)
│   ├── mcp-app/      # Schedule app (HTML/TS)
│   └── src/mcpApp.ts
├── plugin/           # Revit add-in (WebSocket bridge, MCP toggle)
├── commandset/       # Revit API commands (incl. public query / SetParameter)
├── command.json
└── LICENSE
```

## License

[MIT](LICENSE) — see original project: [mcp-servers-for-revit](https://github.com/mcp-servers-for-revit/mcp-servers-for-revit).
