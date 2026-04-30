# Bridge fixture: missing_module

This directory deliberately omits the compiled `dist/` tree that
`claude_command_bridge.initRouter()` requires.  Tests in
`tests/unit/claude_command_bridge.test.ts` point the bridge at this
directory (or use jest module-mocking) to provoke a `MODULE_NOT_FOUND`
error and verify the bridge wraps it as a `BridgeError` with the
documented `npm install && npm run build` resolution.

Do not add real files here.  The fixture's value is its emptiness.
