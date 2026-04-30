# Bridge test fixtures (SPEC-011-2-03)

Fixtures supporting `tests/unit/claude_command_bridge.test.ts`.

| Path | Used by | Purpose |
|------|---------|---------|
| `missing_module/` | MODULE_NOT_FOUND test | Empty directory; resolving a `dist/` path inside it fails. |
| `locked_db.sqlite3` | DATABASE_CONNECTION test | Created at runtime in a `beforeAll` and `chmod 0000` to provoke `SQLITE_CANTOPEN`.  Not committed — git does not preserve write bits portably. |

The integration test (`tests/integration/claude_commands.test.ts`)
does not consume these fixtures — it operates on the real
`commands/` directory.
